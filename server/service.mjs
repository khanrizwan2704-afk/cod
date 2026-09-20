import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  initialState,
  cleanName,
  normalizeName,
  pairKey,
  validateScores,
  leagueSummary,
  REACTIONS,
} from '../lib/league.js';
export const CHUNK_BYTES = 2_000_000,
  MAX_VIDEO_BYTES = 20_000_000,
  MAX_IMAGE_BYTES = 4_000_000;
const HASH = /^[a-f0-9]{64}$/,
  UUID = /^[a-f0-9-]{36}$/,
  digest = (v) => createHash('sha256').update(v).digest('hex');
class Problem extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const assert = (ok, message, status) => {
    if (!ok) throw new Problem(message, status);
  },
  text = (v, max = 160) =>
    String(v ?? '')
      .normalize('NFKC')
      .trim()
      .slice(0, max),
  domain = (fn) => {
    try {
      return fn();
    } catch (e) {
      throw new Problem(e.message);
    }
  };
async function readLimited(req) {
  assert(
    Number(req.headers.get('content-length') || 0) <= 4_100_000,
    'Upload is too large.',
    413,
  );
  const r = req.body?.getReader();
  if (!r) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await r.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4_100_000) {
      await r.cancel();
      throw new Problem('Upload is too large.', 413);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
function signature(b, mime) {
  return mime === 'video/mp4'
    ? b.length > 12 && b.subarray(4, 8).toString() === 'ftyp'
    : mime === 'video/webm' &&
        b.length > 4 &&
        b.subarray(0, 4).toString('hex') === '1a45dfa3';
}
export function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  assert(m && (m[1] || m[2]), 'Invalid range.', 416);
  let start, end;
  if (!m[1]) {
    assert(Number(m[2]) > 0, 'Invalid range.', 416);
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  assert(
    Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start >= 0 &&
      start < size &&
      end >= start,
    'Invalid range.',
    416,
  );
  return { start, end: Math.min(end, start + CHUNK_BYTES - 1), partial: true };
}
export function createService({
  store,
  extract,
  now = () => new Date(),
  mode = 'shared',
}) {
  async function current() {
    let r = await store.read('league');
    if (!r) {
      await store.write('league', initialState());
      r = await store.read('league');
    }
    assert(r?.data, 'League storage unavailable.', 503);
    return r;
  }
  async function mutate(fn) {
    for (let i = 0; i < 8; i++) {
      const { data, etag } = await current();
      const result = fn(data);
      data.version++;
      data.updatedAt = now().toISOString();
      if (await store.write('league', data, etag)) return result;
    }
    throw new Problem(
      'Another upload is being saved. Refresh and try again.',
      409,
    );
  }
  async function rate(key, limit) {
    const path = 'limits/' + digest(key),
      bucket = Math.floor(now().getTime() / 60000);
    for (let i = 0; i < 8; i++) {
      const r = await store.read(path),
        count = r?.data.bucket === bucket ? r.data.count : 0;
      assert(
        count < limit,
        'Too many requests. Wait a minute and try again.',
        429,
      );
      if (await store.write(path, { bucket, count: count + 1 }, r?.etag))
        return;
    }
    throw new Problem('Wait a moment and retry.', 429);
  }
  function publicState(s, owner) {
    const claimedPlayer = s.players.find((p) => p.pinOwner && p.pinOwner === owner);
    const myPlayerId = claimedPlayer ? claimedPlayer.id : null;
    return {
      ...s,
      mode,
      myPlayerId,
      players: s.players.map(({ pinHash, pinOwner, ...p }) => {
        const isMine = pinOwner ? pinOwner === owner : false;
        const isClaimedByOther = pinOwner ? pinOwner !== owner : false;
        return {
          ...p,
          pinOwned: isMine || (!myPlayerId && !pinOwner),
          isMyPlayer: isMine,
          pinClaimed: Boolean(pinOwner),
          claimedByOther: isClaimedByOther,
        };
      }),
      matches: s.matches.map(({ submissionKey, submissionDigest, ...m }) => ({
        ...m,
        acceptedA: m.acceptedA || null,
        acceptedB: m.acceptedB || null,
        reports: (m.reports || []).map(({ owner: o, ...r }) => ({
          ...r,
          mine: o === owner,
        })),
      })),
      clips: s.clips.map(({ reactions, uploadId, ...c }) => ({
        ...c,
        reactions: Object.fromEntries(
          REACTIONS.map((r) => [
            r,
            Object.values(reactions || {}).filter((v) => v === r).length,
          ]),
        ),
        myReaction: reactions?.[owner] || null,
      })),
    };
  }
  function pair(s, a, b) {
    assert(
      s.players.some((p) => p.id === a) && s.players.some((p) => p.id === b),
      'Select both roster players.',
    );
    return domain(() => pairKey(a, b));
  }
  async function session(id, owner) {
    assert(UUID.test(String(id)), 'Invalid upload.');
    const r = await store.read('upload/' + id);
    assert(r && r.data.owner === owner, 'Upload not found.', 404);
    assert(
      r.data.expires > now().getTime(),
      'Upload expired. Choose the video again.',
      410,
    );
    return r;
  }
  const json = (data, status = 200) =>
    Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
  async function dispatch(req, owner, ip) {
    const url = new URL(req.url),
      action = url.searchParams.get('action') || 'state';
    if (req.method === 'GET' || req.method === 'HEAD') {
      const { data } = await current();
      if (action === 'state') return json(publicState(data, owner));
      if (action === 'evidence') {
        const id = url.searchParams.get('id');
        assert(HASH.test(id || ''), 'Evidence not found.', 404);
        const m = data.matches.find((m) => m.evidenceId === id);
        assert(m, 'Evidence not found.', 404);
        const b = await store.bytes('evidence/' + id);
        assert(b, 'Evidence temporarily unavailable.', 503);
        return new Response(req.method === 'HEAD' ? null : b, {
          headers: {
            'Content-Type': m.evidenceMime,
            'Content-Length': String(b.byteLength),
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        });
      }
      if (action === 'video') {
        const c = data.clips.find((c) => c.id === url.searchParams.get('id'));
        assert(c, 'Video not found.', 404);
        const { start, end, partial } = parseRange(
          req.headers.get('range'),
          c.size,
        );
        let offset = start;
        const stream = new ReadableStream({
          async pull(controller) {
            if (offset > end) {
              controller.close();
              return;
            }
            const i = Math.floor(offset / CHUNK_BYTES),
              bytes = await store.bytes('chunks/' + c.uploadId + '/' + i);
            if (!bytes) {
              controller.error(Error('Missing video chunk.'));
              return;
            }
            const b = new Uint8Array(bytes),
              lo = offset % CHUNK_BYTES,
              n = Math.min(b.length - lo, end - offset + 1);
            if (n <= 0) {
              controller.error(Error('Invalid chunk.'));
              return;
            }
            controller.enqueue(b.slice(lo, lo + n));
            offset += n;
          },
        });
        return new Response(req.method === 'HEAD' ? null : stream, {
          status: partial ? 206 : 200,
          headers: {
            'Content-Type': c.mime,
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes',
            ...(partial
              ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + c.size }
              : {}),
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        });
      }
      throw new Problem('Not found.', 404);
    }
    assert(['POST', 'PUT'].includes(req.method), 'Method not allowed.', 405);
    assert(
      req.headers.get('x-league-client') === 'web',
      'Use the league upload form.',
      403,
    );
    const origin = req.headers.get('origin');
    assert(
      !origin || origin === url.origin,
      'Cross-site writes are not allowed.',
      403,
    );
    assert(
      req.headers.get('sec-fetch-site') !== 'cross-site',
      'Cross-site writes are not allowed.',
      403,
    );
    await rate('writes:' + (ip || owner), 100);
    const body = await readLimited(req);
    if (action === 'extract') {
      await rate('ocr:' + (ip || owner), 6);
      const form = await new Response(body, {
          headers: { 'Content-Type': req.headers.get('content-type') || '' },
        })
          .formData()
          .catch(() => {
            throw new Problem('Choose a scoreboard image.');
          }),
        file = form.get('screenshot');
      assert(
        file && typeof file.arrayBuffer === 'function',
        'Choose a scoreboard image.',
      );
      assert(
        file.size > 0 && file.size <= MAX_IMAGE_BYTES,
        'Screenshots must be under 4 MB.',
        413,
      );
      assert(
        ['image/png', 'image/jpeg', 'image/webp'].includes(file.type),
        'Use PNG, JPG or WebP.',
      );
      const bytes = Buffer.from(await file.arrayBuffer()),
        id = digest(bytes),
        { data } = await current();
      assert(
        !data.matches.some((m) => m.evidenceId === id),
        'This exact screenshot already belongs to a posted result.',
        409,
      );
      const cached = await store.read('draft/' + id);
      let extraction = cached?.data.extraction;
      if (!extraction) {
        try {
          extraction = await extract(bytes, data.players);
        } catch {
          throw new Problem(
            'Could not read this scoreboard. Try a clear, full-resolution final screenshot.',
            422,
          );
        }
        assert(
          extraction.rawText?.trim().length >= 4,
          'No scoreboard text could be read.',
          422,
        );
        await store.putBytes('evidence/' + id, bytes);
        await store.write('draft/' + id, {
          extraction,
          createdAt: now().toISOString(),
        });
      }
      const receipt = randomBytes(32).toString('hex');
      await store.write('receipt/' + digest(receipt), {
        owner,
        evidenceId: id,
        expires: now().getTime() + 3600000,
      });
      return json({ id, receipt, extraction });
    }
    if (action === 'chunk') {
      const id = url.searchParams.get('id'),
        i = Number(url.searchParams.get('index')),
        { data: u } = await session(id, owner);
      assert(!u.completed, 'Video already posted.', 409);
      assert(Number.isInteger(i) && i >= 0 && i < u.chunks, 'Invalid chunk.');
      assert(
        body.length === Math.min(CHUNK_BYTES, u.size - i * CHUNK_BYTES),
        'Incomplete video chunk.',
      );
      if (i === 0)
        assert(
          signature(body, u.mime),
          'File is not a supported MP4 or WebM video.',
        );
      const hash = digest(body),
        key = 'manifest/' + id + '/' + i,
        old = await store.read(key);
      assert(
        !old || old.data.hash === hash,
        'Conflicting chunk. Start the upload again.',
        409,
      );
      if (!old) {
        await store.putBytes('chunk-data/' + hash, body);
        if (!(await store.write(key, { hash }))) {
          const saved = await store.read(key);
          assert(
            saved?.data.hash === hash,
            'Conflicting chunk. Start again.',
            409,
          );
        }
      }
      return json({ received: i });
    }
    let input;
    try {
      input = JSON.parse(body.toString());
    } catch {
      throw new Problem('Invalid request.');
    }
    assert(
      input && typeof input === 'object' && !Array.isArray(input),
      'Invalid request.',
    );
    if (action === 'player') {
      const name = domain(() => cleanName(input.name)),
        id = normalizeName(name);
      const pin = String(Math.floor(100000 + Math.random() * 900000));
      const pinHash = digest(id + ':' + pin);
      await mutate((s) => {
        assert(
          !leagueSummary(s).rosterLocked,
          'The roster locks after the first result to keep the season fair.',
          409,
        );
        assert(s.players.length < 24, 'This season supports up to 24 players.');
        assert(
          !s.players.some((p) => normalizeName(p.name) === id),
          'That player is already on the roster.',
          409,
        );
        s.players.push({ id, name, pinHash, pinOwner: owner });
      });
      return json({ message: 'Player added.', pin }, 201);
    }
    if (action === 'schedule') {
      await mutate((s) => {
        const id = pair(s, input.playerA, input.playerB);
        assert(
          !s.matches.some((m) => m.id === id),
          'This matchup is already queued or completed. Reverse names count as the same match.',
          409,
        );
        s.matches.push({
          id,
          playerA: input.playerA,
          playerB: input.playerB,
          status: 'queued',
          createdAt: now().toISOString(),
        });
      });
      return json(
        { message: 'Match queued. Post the scoreboard when finished.' },
        201,
      );
    }
    if (action === 'result') {
      assert(
        !input.submissionId || UUID.test(input.submissionId),
        'Invalid save receipt.',
      );
      const submissionKey = input.submissionId
        ? digest(owner + ':' + input.submissionId)
        : null;
      const submissionDigest = digest(
        JSON.stringify([
          input.playerA,
          input.playerB,
          input.scoreA,
          input.scoreB,
          input.evidenceId,
          input.map || '',
          input.correctionNote || '',
          input.attested,
        ]),
      );
      assert(
        HASH.test(input.evidenceId || '') && HASH.test(input.receipt || ''),
        'Upload a scoreboard first.',
      );
      const access = await store.read('receipt/' + digest(input.receipt));
      assert(
        access &&
          access.data.owner === owner &&
          access.data.evidenceId === input.evidenceId &&
          access.data.expires > now().getTime(),
        'Review expired. Upload the screenshot again.',
        403,
      );
      const draft = await store.read('draft/' + input.evidenceId);
      assert(draft, 'Upload the screenshot again.');
      assert(
        input.attested === true,
        'Confirm that this is a real final scoreboard.',
      );
      domain(() => validateScores(input.scoreA, input.scoreB));
      const expected = draft.data.extraction.candidates,
        corrected =
          expected.length !== 2 ||
          expected[0]?.playerId !== input.playerA ||
          expected[1]?.playerId !== input.playerB ||
          expected[0]?.score !== input.scoreA ||
          expected[1]?.score !== input.scoreB,
        note = text(input.correctionNote, 300);
      assert(
        !corrected || note.length >= 8,
        'Explain any OCR corrections or missing fields (at least 8 characters).',
      );
      const { data: currentData } = await current();
      const existingMatch = currentData.matches.find(
        (m) => m.id === pair(currentData, input.playerA, input.playerB),
      );
      if (existingMatch && (existingMatch.acceptedA || existingMatch.acceptedB)) {
        assert(
          existingMatch.acceptedA && existingMatch.acceptedB,
          'Both players must enter their PIN and agree to the match charter before posting results.',
          403,
        );
      }
      const saved = await mutate((s) => {
        const id = pair(s, input.playerA, input.playerB),
          old = s.matches.find((m) => m.id === id);
        if (submissionKey) {
          const previous = s.matches.find(
            (m) => m.submissionKey === submissionKey,
          );
          if (previous) {
            assert(
              previous.submissionDigest === submissionDigest,
              'This save receipt was already used for different details.',
              409,
            );
            return {
              matchId: previous.id,
              savedAt: previous.completedAt,
              receiptId: previous.receiptId,
              alreadySaved: true,
            };
          }
        }
        assert(
          old?.status !== 'completed',
          'A result already exists for these players, including the reverse matchup.',
          409,
        );
        assert(
          !s.matches.some((m) => m.evidenceId === input.evidenceId),
          'This image already belongs to a result.',
          409,
        );
        s.matches = s.matches.filter((m) => m.id !== id);
        s.matches.push({
          id,
          playerA: input.playerA,
          playerB: input.playerB,
          scoreA: input.scoreA,
          scoreB: input.scoreB,
          status: 'completed',
          map: text(input.map, 40),
          evidenceId: input.evidenceId,
          evidenceMime: draft.data.extraction.mime,
          extraction: {
            candidates: expected,
            confidence: draft.data.extraction.confidence,
          },
          corrected,
          correctionNote: corrected ? note : '',
          createdAt: old?.createdAt || now().toISOString(),
          completedAt: now().toISOString(),
          acceptedA: old?.acceptedA || now().toISOString(),
          acceptedB: old?.acceptedB || now().toISOString(),
          receiptId: randomUUID(),
          reports: [],
          ...(submissionKey ? { submissionKey, submissionDigest } : {}),
        });
        for (const pid of [input.playerA, input.playerB]) {
          const pl = s.players.find((p) => p.id === pid);
          if (pl) {
            const nextPin = String(Math.floor(100000 + Math.random() * 900000));
            pl.pinHash = digest(pid + ':' + nextPin);
            pl.lastGeneratedPin = nextPin;
          }
        }
        return {
          matchId: id,
          savedAt: s.matches.at(-1).completedAt,
          receiptId: s.matches.at(-1).receiptId,
          alreadySaved: false,
        };
      });
      return json(
        { message: 'Result saved to the league.', ...saved },
        saved.alreadySaved ? 200 : 201,
      );
    }
    if (action === 'report') {
      const reason = text(input.reason, 400);
      assert(
        reason.length >= 12,
        'Describe the issue in at least 12 characters.',
      );
      await mutate((s) => {
        const m = s.matches.find(
          (m) => m.id === input.matchId && m.status === 'completed',
        );
        assert(m, 'Result not found.', 404);
        m.reports ||= [];
        assert(
          !m.reports.some((r) => r.owner === owner),
          'You already reported this result.',
          409,
        );
        assert(
          m.reports.length < 20,
          'This result already has enough reports.',
          409,
        );
        m.reports.push({
          id: randomUUID(),
          owner,
          reason,
          createdAt: now().toISOString(),
        });
      });
      return json({ message: 'Report added. The final crown is held.' });
    }
    if (action === 'withdraw-report') {
      await mutate((s) => {
        const m = s.matches.find((m) => m.id === input.matchId),
          r = m?.reports?.find((r) => r.id === input.reportId);
        assert(
          r?.owner === owner,
          'Only the reporting browser can withdraw this report.',
          403,
        );
        m.reports = m.reports.filter((r) => r.id !== input.reportId);
      });
      return json({ message: 'Report withdrawn.' });
    }
    if (action === 'accept-charter') {
      const playerId = text(input.playerId, 40);
      const pin = text(input.pin, 10);
      assert(playerId && pin.length === 6, 'Enter your 6-digit player PIN.');
      await mutate((s) => {
        const player = s.players.find((p) => p.id === playerId);
        assert(player, 'Player not found on the roster.', 404);
        if (!player.pinHash) {
          player.pinHash = digest(playerId + ':' + pin);
          player.pinOwner = owner;
        }
        const expectedHash = digest(playerId + ':' + pin);
        assert(
          expectedHash === player.pinHash,
          'Incorrect PIN. Only the private PIN generated for this player will be accepted.',
          403,
        );
        const matchId = text(input.matchId, 80);
        let m = s.matches.find((mm) => mm.id === matchId);
        if (!m) {
          const parts = matchId.split('~');
          if (parts.length === 2 && s.players.some((p) => p.id === parts[0]) && s.players.some((p) => p.id === parts[1])) {
            m = {
              id: matchId,
              playerA: parts[0],
              playerB: parts[1],
              status: 'queued',
              createdAt: now().toISOString(),
            };
            s.matches.push(m);
          }
        }
        assert(m, 'Match not found.', 404);
        assert(
          m.playerA === playerId || m.playerB === playerId,
          'This player is not part of this match.',
          403,
        );
        if (m.playerA === playerId) {
          assert(!m.acceptedA, 'Player A has already accepted this charter.', 409);
          m.acceptedA = now().toISOString();
        } else {
          assert(!m.acceptedB, 'Player B has already accepted this charter.', 409);
          m.acceptedB = now().toISOString();
        }
      });
      return json({ message: 'Charter accepted. Your word is locked in.' });
    }
    if (action === 'reveal-pin') {
      const playerId = text(input.playerId, 40);
      assert(playerId, 'Select a player.');
      const { data } = await current();
      const player = data.players.find((p) => p.id === playerId);
      assert(player, 'Player not found.', 404);
      
      const existingClaim = data.players.find((p) => p.pinOwner && p.pinOwner === owner);
      if (existingClaim && existingClaim.id !== playerId) {
        throw new Problem(
          `Your device is already registered as ${existingClaim.name}. You can only manage your own PIN.`,
          403,
        );
      }
      assert(
        !player.pinOwner || player.pinOwner === owner,
        'PIN already generated for this player. Please contact admin if this is your name.',
        403,
      );
      // If player already has an active generated PIN and owner just wants to see it again (not force-reset)
      if (player.lastGeneratedPin && !input.forceReset) {
        return json({ message: 'Here is your active private PIN.', pin: player.lastGeneratedPin });
      }
      const newPin = String(Math.floor(100000 + Math.random() * 900000));
      const newHash = digest(playerId + ':' + newPin);
      await mutate((s) => {
        const claim = s.players.find((p) => p.pinOwner && p.pinOwner === owner);
        if (claim && claim.id !== playerId) {
          throw new Problem(
            `Your device is already registered as ${claim.name}. You can only manage your own PIN.`,
            403,
          );
        }
        const p = s.players.find((pp) => pp.id === playerId);
        assert(p, 'Player not found.', 404);
        assert(
          !p.pinOwner || p.pinOwner === owner,
          'PIN already generated for this player. Please contact admin if this is your name.',
          403,
        );
        p.pinHash = newHash;
        p.pinOwner = owner;
        p.lastGeneratedPin = newPin;
      });
      return json({ message: 'Unique PIN generated for this player.', pin: newPin });
    }
    if (action === 'reset-all-pins') {
      await mutate((s) => {
        for (const p of s.players) {
          delete p.pinHash;
          delete p.pinOwner;
          delete p.lastGeneratedPin;
        }
      });
      return json({ message: 'All player PINs and device claims have been cleared.' });
    }
    if (action === 'video-start') {
      await rate('video:' + (ip || owner), 5);
      const title = text(input.title, 80);
      assert(
        title.length >= 3,
        'Give the clip a title of at least 3 characters.',
      );
      assert(
        ['video/mp4', 'video/webm'].includes(input.mime),
        'Use MP4 or WebM.',
      );
      assert(
        Number.isInteger(input.size) &&
          input.size > 12 &&
          input.size <= MAX_VIDEO_BYTES,
        'Clips must be under 20 MB.',
        413,
      );
      assert(HASH.test(input.hash || ''), 'Could not verify this video.');
      const { data } = await current();
      assert(
        data.players.some((p) => p.id === input.playerId),
        'Choose a roster player.',
      );
      assert(
        data.clips.length < 100,
        'This season has reached its 100-clip limit.',
      );
      assert(
        !data.clips.some((c) => c.hash === input.hash),
        'This video is already posted.',
        409,
      );
      const id = randomUUID(),
        chunks = Math.ceil(input.size / CHUNK_BYTES);
      await store.write('upload/' + id, {
        id,
        owner,
        title,
        playerId: input.playerId,
        size: input.size,
        mime: input.mime,
        hash: input.hash,
        chunks,
        expires: now().getTime() + 3600000,
      });
      return json({ id, chunks, chunkBytes: CHUNK_BYTES }, 201);
    }
    if (action === 'video-finish') {
      const record = await session(input.id, owner),
        u = record.data;
      if (u.completed) return json({ message: 'Clip already posted.' });
      const hasher = createHash('sha256');
      for (let i = 0; i < u.chunks; i++) {
        const manifest = await store.read('manifest/' + u.id + '/' + i),
          bytes =
            manifest && (await store.bytes('chunk-data/' + manifest.data.hash));
        assert(bytes, 'Upload incomplete. Please retry.');
        const b = Buffer.from(bytes);
        assert(
          b.length === Math.min(CHUNK_BYTES, u.size - i * CHUNK_BYTES),
          'A chunk is incomplete.',
        );
        if (i === 0) assert(signature(b, u.mime), 'Invalid video format.');
        hasher.update(b);
        await store.putBytes('chunks/' + u.id + '/' + i, b);
      }
      assert(
        hasher.digest('hex') === u.hash,
        'Video integrity check failed. Upload again.',
      );
      await mutate((s) => {
        assert(
          !s.clips.some((c) => c.hash === u.hash),
          'Video already posted.',
          409,
        );
        assert(s.clips.length < 100, 'Season clip limit reached.');
        s.clips.push({
          id: u.id,
          uploadId: u.id,
          hash: u.hash,
          title: u.title,
          playerId: u.playerId,
          size: u.size,
          mime: u.mime,
          createdAt: now().toISOString(),
          reactions: {},
        });
      });
      await store.write(
        'upload/' + u.id,
        { ...u, completed: true },
        record.etag,
      );
      return json({ message: 'Gameplay posted.' }, 201);
    }
    if (action === 'react') {
      assert(
        REACTIONS.includes(input.reaction) || input.reaction === null,
        'Invalid reaction.',
      );
      await mutate((s) => {
        const c = s.clips.find((c) => c.id === input.clipId);
        assert(c, 'Clip not found.', 404);
        c.reactions ||= {};
        if (input.reaction === null) delete c.reactions[owner];
        else c.reactions[owner] = input.reaction;
      });
      return json({ message: 'Reaction updated.' });
    }
    throw new Problem('Not found.', 404);
  }
  return async (req, context = {}) => {
    let token = req.headers
      .get('cookie')
      ?.match(/(?:^|;\s*)solo_visitor=([a-f0-9]{64})(?:;|$)/)?.[1];
    const fresh = !token;
    token ||= randomBytes(32).toString('hex');
    let response;
    try {
      response = await dispatch(req, digest(token), context.ip);
    } catch (e) {
      if (!e.status) console.error('League request:', e.message);
      response = json(
        {
          error: e.status
            ? e.message
            : 'The league is temporarily unavailable. Refresh before retrying.',
        },
        e.status || 503,
      );
    }
    response.headers.set('X-Content-Type-Options', 'nosniff');
    if (fresh && response.headers.get('Cache-Control') === 'no-store')
      response.headers.append(
        'Set-Cookie',
        'solo_visitor=' +
          token +
          '; HttpOnly; SameSite=Strict; Path=/; Max-Age=15552000' +
          (new URL(req.url).protocol === 'https:' ? '; Secure' : ''),
      );
    return response;
  };
}
