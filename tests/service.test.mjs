import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createService, parseRange, CHUNK_BYTES } from '../server/service.mjs';
const digest = (value) => createHash('sha256').update(value).digest('hex');
function memoryStore() {
  const records = new Map(),
    binary = new Map();
  let n = 0;
  return {
    read: async (k) => structuredClone(records.get(k) || null),
    write: async (k, data, etag) => {
      const old = records.get(k);
      if (etag ? old?.etag !== etag : old) return false;
      records.set(k, { etag: String(++n), data: structuredClone(data) });
      return true;
    },
    putBytes: async (k, b) => binary.set(k, Buffer.from(b)),
    bytes: async (k) => binary.get(k) || null,
    remove: async (k) => {
      records.delete(k);
      binary.delete(k);
    },
  };
}
function setup() {
  const store = memoryStore(),
    handler = createService({
      store,
      extract: async () => ({
        rawText: 'SYNTHETIC TEST: bowdownbro 6 snowstorm 4',
        confidence: 95,
        mime: 'image/png',
        candidates: [
          { playerId: 'bowdownbro', score: 6 },
          { playerId: 'snowstorm', score: 4 },
        ],
        warnings: [],
      }),
    });
  function client(token = 'a'.repeat(64)) {
    return async (action = 'state', body, opts = {}) => {
      const form = body instanceof FormData,
        bytes = Buffer.isBuffer(body);
      const headers = {
        cookie: 'solo_visitor=' + token,
        ...(body === undefined
          ? {}
          : {
              'X-League-Client': 'web',
              ...(!form
                ? {
                    'Content-Type': bytes
                      ? 'application/octet-stream'
                      : 'application/json',
                  }
                : {}),
            }),
        ...opts.headers,
      };
      return handler(
        new Request(
          'https://league.test/.netlify/functions/league?' +
            new URLSearchParams({ action, ...opts.params }),
          {
            method: opts.method || (body === undefined ? 'GET' : 'POST'),
            headers,
            ...(body === undefined
              ? {}
              : { body: form || bytes ? body : JSON.stringify(body) }),
          },
        ),
      );
    };
  }
  return { store, handler, client };
}
let fixtureNumber = 0;
async function receipt(client) {
  const form = new FormData();
  form.append(
    'screenshot',
    new Blob(['SYNTHETIC UNIT TEST ' + ++fixtureNumber], { type: 'image/png' }),
    'synthetic-test.png',
  );
  const res = await client('extract', form);
  assert.equal(res.status, 200);
  return res.json();
}
const submission = (r) => ({
  playerA: 'bowdownbro',
  playerB: 'snowstorm',
  scoreA: 6,
  scoreB: 4,
  attested: true,
  evidenceId: r.id,
  receipt: r.receipt,
});
test('concurrent reversed results create exactly one official record', async () => {
  const { client } = setup(),
    a = client(),
    b = client('b'.repeat(64)),
    ra = await receipt(a),
    rb = await receipt(b);
  const responses = await Promise.all([
    a('result', submission(ra)),
    b('result', {
      ...submission(rb),
      playerA: 'snowstorm',
      playerB: 'bowdownbro',
      scoreA: 4,
      scoreB: 6,
      correctionNote: 'Reversed row order in this synthetic test.',
    }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const state = await (await a()).json();
  assert.equal(state.matches.length, 1);
  assert.equal(state.matches[0].status, 'completed');
});
test('score, receipt ownership and OCR corrections are validated on the server', async () => {
  const { client } = setup(),
    a = client(),
    b = client('b'.repeat(64)),
    r = await receipt(a),
    valid = submission(r);
  assert.equal((await b('result', valid)).status, 403);
  for (const scores of [
    [7, 4],
    [6, 6],
    [1.5, 0],
    ['6', 4],
  ])
    assert.equal(
      (await a('result', { ...valid, scoreA: scores[0], scoreB: scores[1] }))
        .status,
      400,
    );
  assert.equal((await a('result', { ...valid, scoreA: 5 })).status, 400);
  assert.equal((await a('result', { ...valid, attested: false })).status, 400);
  assert.equal(
    (
      await a('result', {
        ...valid,
        scoreA: 5,
        correctionNote: 'Test score correction explained.',
      })
    ).status,
    201,
  );
  const state = await (await a()).json();
  assert.equal(state.matches[0].corrected, true);
});
test('queued pairs cannot repeat and transition to a completed result once', async () => {
  const { client } = setup(),
    c = client();
  assert.equal(
    (await c('schedule', { playerA: 'bowdownbro', playerB: 'snowstorm' }))
      .status,
    201,
  );
  assert.equal(
    (await c('schedule', { playerA: 'snowstorm', playerB: 'bowdownbro' }))
      .status,
    409,
  );
  assert.equal(
    (await c('schedule', { playerA: 'bowdownbro', playerB: 'bowdownbro' }))
      .status,
    400,
  );
  const r = await receipt(c);
  assert.equal((await c('result', submission(r))).status, 201);
  assert.equal((await c('result', submission(r))).status, 409);
  assert.equal((await (await c()).json()).matches.length, 1);
});
test('the roster rejects canonical duplicates and locks after the first result', async () => {
  const { client } = setup(),
    c = client();
  assert.equal((await c('player', { name: 'Bow_Down_Bro' })).status, 409);
  assert.equal(
    (await c('player', { name: 'ActualNewParticipant' })).status,
    201,
  );
  const r = await receipt(c);
  await c('result', submission(r));
  assert.equal((await c('player', { name: 'TooLate' })).status, 409);
  assert.equal(
    (
      await c('result', {
        ...submission(r),
        playerB: 'fiercekhan',
        correctionNote: 'Test different matchup using the same image.',
      })
    ).status,
    409,
  );
});
test('evidence is public only after posting; reports hide owners and only reporters withdraw', async () => {
  const { client } = setup(),
    a = client(),
    b = client('b'.repeat(64)),
    r = await receipt(a);
  assert.equal(
    (await a('evidence', undefined, { params: { id: r.id } })).status,
    404,
  );
  await a('result', submission(r));
  let state = await (await a()).json(),
    id = state.matches[0].id;
  const evidence = await a('evidence', undefined, { params: { id: r.id } });
  assert.equal(evidence.status, 200);
  assert.equal(evidence.headers.get('content-type'), 'image/png');
  assert.equal(
    (
      await a('report', {
        matchId: id,
        reason: 'Synthetic test: score needs checking.',
      })
    ).status,
    200,
  );
  state = await (await a()).json();
  let report = state.matches[0].reports[0];
  assert.equal(report.mine, true);
  assert.equal(report.owner, undefined);
  assert.equal(
    (await b('withdraw-report', { matchId: id, reportId: report.id })).status,
    403,
  );
  assert.equal(
    (await a('withdraw-report', { matchId: id, reportId: report.id })).status,
    200,
  );
});
test('video chunks are immutable, verified, range-served and shared with one reaction per browser', async () => {
  const { client } = setup(),
    a = client(),
    b = client('b'.repeat(64));
  const bytes = Buffer.alloc(CHUNK_BYTES + 70, 7);
  bytes.write('ftyp', 4);
  const res = await a('video-start', {
    title: 'Synthetic test clip',
    playerId: 'bowdownbro',
    size: bytes.length,
    mime: 'video/mp4',
    hash: digest(bytes),
  });
  assert.equal(res.status, 201);
  const u = await res.json();
  assert.equal(
    (
      await b('chunk', bytes.subarray(0, CHUNK_BYTES), {
        method: 'PUT',
        params: { id: u.id, index: 0 },
      })
    ).status,
    404,
  );
  assert.equal((await a('video-finish', { id: u.id })).status, 400);
  for (let i = 0; i < u.chunks; i++)
    assert.equal(
      (
        await a(
          'chunk',
          bytes.subarray(
            i * CHUNK_BYTES,
            Math.min(bytes.length, (i + 1) * CHUNK_BYTES),
          ),
          { method: 'PUT', params: { id: u.id, index: i } },
        )
      ).status,
      200,
    );
  const altered = Buffer.from(bytes.subarray(0, CHUNK_BYTES));
  altered[20] = 8;
  assert.equal(
    (
      await a('chunk', altered, {
        method: 'PUT',
        params: { id: u.id, index: 0 },
      })
    ).status,
    409,
  );
  assert.equal((await a('video-finish', { id: u.id })).status, 201);
  const range = await a('video', undefined, {
    params: { id: u.id },
    headers: { Range: `bytes=${CHUNK_BYTES - 4}-${CHUNK_BYTES + 12}` },
  });
  assert.equal(range.status, 206);
  assert.deepEqual(
    Buffer.from(await range.arrayBuffer()),
    bytes.subarray(CHUNK_BYTES - 4, CHUNK_BYTES + 13),
  );
  assert.equal(
    (await a('react', { clipId: u.id, reaction: 'fire' })).status,
    200,
  );
  await a('react', { clipId: u.id, reaction: 'clutch' });
  await b('react', { clipId: u.id, reaction: 'gg' });
  const state = await (await a()).json();
  assert.deepEqual(state.clips[0].reactions, { fire: 0, clutch: 1, gg: 1 });
  assert.equal(state.clips[0].myReaction, 'clutch');
  assert.equal(state.clips[0].uploadId, undefined);
  await a('react', { clipId: u.id, reaction: null });
  assert.equal((await (await a()).json()).clips[0].reactions.clutch, 0);
});
test('cross-site and oversized mutations fail before writing', async () => {
  const { client } = setup(),
    c = client();
  assert.equal(
    (
      await c(
        'player',
        { name: 'test player' },
        { headers: { origin: 'https://other.example' } },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await c(
        'player',
        { name: 'test player' },
        { headers: { 'X-League-Client': '' } },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await c(
        'player',
        { name: 'test player' },
        { headers: { 'Content-Length': '9000000' } },
      )
    ).status,
    413,
  );
  assert.equal((await (await c()).json()).players.length, 7);
});
test('PIN generation binds to a single player per device and blocks claiming others', async () => {
  const { client } = setup(),
    deviceA = client('a'.repeat(64)),
    deviceB = client('b'.repeat(64));

  // Device A generates PIN for fiercekhan
  const res1 = await deviceA('reveal-pin', { playerId: 'fiercekhan' });
  assert.equal(res1.status, 200);
  const data1 = await res1.json();
  assert.equal(typeof data1.pin, 'string');
  assert.equal(data1.pin.length, 6);

  // Device A can re-view fiercekhan's active PIN
  const resView = await deviceA('reveal-pin', { playerId: 'fiercekhan' });
  assert.equal(resView.status, 200);
  const dataView = await resView.json();
  assert.equal(dataView.pin, data1.pin);

  // Device A attempts to claim or generate PIN for bowdownbro -> blocked
  const resAOther = await deviceA('reveal-pin', { playerId: 'bowdownbro' });
  assert.equal(resAOther.status, 403);
  const errAOther = await resAOther.json();
  assert.match(errAOther.error, /Your device is already registered as/);

  // Device B attempts to generate/reveal fiercekhan -> blocked
  const resBClaim = await deviceB('reveal-pin', { playerId: 'fiercekhan' });
  assert.equal(resBClaim.status, 403);
  const errBClaim = await resBClaim.json();
  assert.match(errBClaim.error, /PIN already generated for this player/);

  // Device B can generate PIN for bowdownbro
  const res2 = await deviceB('reveal-pin', { playerId: 'bowdownbro' });
  assert.equal(res2.status, 200);

  // publicState exposes myPin only to the claiming owner
  const stateA = await (await deviceA('state')).json();
  const plA = stateA.players.find((p) => p.id === 'fiercekhan');
  const plBInA = stateA.players.find((p) => p.id === 'bowdownbro');
  assert.equal(plA.myPin, data1.pin);
  assert.equal(plBInA.myPin, undefined);

  // Reset all pins clears claims but preserves roster and standings
  const resReset = await deviceA('reset-all-pins', {});
  assert.equal(resReset.status, 200);
  const stateAfterReset = await (await deviceA('state')).json();
  assert.equal(stateAfterReset.players.length, stateA.players.length);
  assert.equal(stateAfterReset.myPlayerId, null);
});
test('range parsing handles suffixes and rejects invalid/out-of-bounds requests', () => {
  assert.deepEqual(parseRange('bytes=-10', 100), {
    start: 90,
    end: 99,
    partial: true,
  });
  assert.deepEqual(parseRange(null, 100), {
    start: 0,
    end: 99,
    partial: false,
  });
  for (const value of [
    'bytes=100-',
    'bytes=10-2',
    'bytes=-0',
    'bytes=0-2,6-8',
    'bad',
  ])
    assert.throws(() => parseRange(value, 100));
  assert.equal(parseRange('bytes=0-', 8_000_000).end, CHUNK_BYTES - 1);
});
