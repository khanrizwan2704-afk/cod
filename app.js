import './styles.css';
import './mobile.css';
import './immersive.css';
import { setupLobby } from './lib/lobby.js';
import { setupSoundtrack } from './lib/soundtrack.js';
import { renderPhone, setupPhone } from './lib/mobile.js';
import { feedback, setupFeedback } from './lib/feedback.js';
import { readDraft, writeDraft, clearDraft } from './lib/draft.js';
import { showSheet, hideSheet } from './lib/sheets.js';
import {
  initialState,
  fixtures,
  standings,
  leagueSummary,
  remainingOpponents,
  reminder,
  normalizeName,
  pairKey,
  validateScores,
  REACTIONS,
} from './lib/league.js';
import { icon, hydrateIcons } from './lib/icons.js';
import { setupMotion } from './lib/motion.js';
import { setupBattleSequence } from './lib/battleSequence.js';
import { setupBattleAudio } from './lib/battleAudio.js';

const $ = (selector) => document.querySelector(selector);
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const endpoint = (action, params = {}) =>
  '/.netlify/functions/league?' + new URLSearchParams({ action, ...params });
let state = initialState(),
  filter = 'all',
  showAll = false,
  modalVersion = 0,
  activeCharterMatchId = null,
  saving = false,
  previewURL = null,
  toastTimer;
const modal = $('#modal'),
  content = $('#modal-content');
let draft = null,
  draftDurable = false,
  draftRevision = 0,
  refreshTask = null;
function showDraft() {
  $('#draft-banner').hidden = !draft;
  $('#draft-banner span').textContent = draftDurable
    ? 'Saved on this device. Finish when ready.'
    : 'Keep this page open to retain this draft.';
}
async function persistDraft() {
  if (!draft) return;
  const revision = ++draftRevision;
  draftDurable = false;
  const durable = await writeDraft({ ...draft, updatedAt: Date.now() });
  if (revision !== draftRevision) return;
  draftDurable = durable;
  showDraft();
}
function connection(mode) {
  const labels = {
    live: '● LIVE',
    syncing: '◌ SYNCING',
    offline: '● OFFLINE',
    updated: '✓ UPDATED',
  };
  $('#header-live').textContent = labels[mode];
  $('#header-live').dataset.state = mode;
}
function postStep(step, label = '') {
  modal.dataset.step = step;
  $('#post-steps').hidden = !step;
  $('#post-state').hidden = !label;
  $('#post-state').textContent = label;
  $('#post-steps')
    .querySelectorAll('li')
    .forEach((el, i) => {
      el.classList.toggle('done', i + 1 < step);
      if (i + 1 === step) el.setAttribute('aria-current', 'step');
      else el.removeAttribute('aria-current');
    });
}
const names = (id) => state?.players.find((p) => p.id === id)?.name || id;
const date = (value) =>
  new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(value),
  );
const avatar = (id) => {
  const index = state.players.findIndex((p) => p.id === id);
  return `<span class="avatar avatar-${index % 6}" aria-hidden="true">${escape(names(id).slice(0, 2).toUpperCase())}</span>`;
};

async function api(
  action,
  body,
  { method, params = {}, timeout = 60_000 } = {},
) {
  if (body !== undefined && !navigator.onLine)
    throw Error(
      'You are offline. Your details remain here. Reconnect before posting.',
    );
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeout);
  const isForm = body instanceof FormData,
    isBytes = body instanceof ArrayBuffer;
  try {
    const response = await fetch(endpoint(action, params), {
      method: method || (body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers:
        body === undefined
          ? {}
          : {
              'X-League-Client': 'web',
              ...(!isForm
                ? {
                    'Content-Type': isBytes
                      ? 'application/octet-stream'
                      : 'application/json',
                  }
                : {}),
            },
      ...(body === undefined
        ? {}
        : { body: isForm || isBytes ? body : JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => {
      throw Error(
        'The league service could not be reached. Refresh and try again.',
      );
    });
    if (!response.ok) {
      const error = Error(data.error || 'This request could not be saved.');
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError')
      throw Error(
        'The request took too long. Refresh to check whether it was saved before retrying.',
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
function toast(message, error = false) {
  if (error) feedback('error');
  clearTimeout(toastTimer);
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.hidden = false;
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}
function refresh(announce = false, afterWrite = false) {
  if (refreshTask)
    return afterWrite
      ? refreshTask.then(() => refresh(announce, true))
      : refreshTask;
  refreshTask = loadState(announce).finally(() => {
    refreshTask = null;
  });
  return refreshTask;
}
async function loadState(announce) {
  connection(navigator.onLine ? 'syncing' : 'offline');
  try {
    const next = await api('state', undefined, { timeout: 15_000 });
    if (!state || next.version >= state.version) {
      const changed = !state || next.version !== state.version;
      const prevMatches = state?.matches;
      state = next;
      if (changed) {
        render();
        if (activeCharterMatchId && modal.open) {
          const m = fixtures(state).find((item) => item.id === activeCharterMatchId);
          if (m) {
            const prevM = prevMatches?.find((item) => item.id === activeCharterMatchId);
            const wasBothAccepted = Boolean(prevM?.acceptedA && prevM?.acceptedB);
            const isBothAccepted = Boolean(m.acceptedA && m.acceptedB);
            if (isBothAccepted && !wasBothAccepted) {
              toast('Both players agreed! Scoreboard upload unlocked.');
              feedback('saved');
              uploadModal(activeCharterMatchId);
            } else if (JSON.stringify(prevM) !== JSON.stringify(m)) {
              matchDetailModal(activeCharterMatchId);
            }
          }
        }
      }
    }
    $('#connection-status').innerHTML =
      `<span class="status-dot"></span>${state.mode === 'local' ? 'Local preview' : 'Connected to the league'} · Checked ${escape(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}`;
    $('#connection-error').hidden = true;
    $('#standings-sync').innerHTML =
      '<span class="status-dot"></span> UP TO DATE';
    connection(announce ? 'updated' : 'live');
    if (announce) toast('League refreshed.');
    return true;
  } catch (error) {
    $('#connection-status').innerHTML =
      '<span class="status-dot offline"></span>Connection interrupted';
    $('#connection-error').textContent =
      (state ? 'Showing the last loaded results. ' : '') + error.message;
    $('#connection-error').hidden = false;
    $('#standings-sync').innerHTML =
      '<span class="status-dot offline"></span> SYNC PAUSED';
    connection('offline');
    if (announce) toast(error.message, true);
    return false;
  }
}

function render() {
  const summary = leagueSummary(state),
    rows = standings(state);
  $('#stat-players').textContent = state.players.length;
  $('#stat-total').textContent = summary.total;
  $('#stat-complete').textContent = summary.completed;
  $('#progress-label').textContent = summary.percent + '%';
  $('#league-progress').style.width = summary.percent + '%';
  $('#progress-caption').textContent = summary.remaining
    ? `${summary.remaining} matchups left. Make yours count.`
    : summary.disputes
      ? 'All played. A reported concern needs resolving.'
      : 'Every matchup is in. The season is complete.';
  $('#roster-ribbon').innerHTML = state.players
    .map((p) => `<span class="ribbon-player">${escape(p.name)}</span>`)
    .join('');
  $('#standings-body').innerHTML = rows
    .map(
      (p) =>
        `<tr><td><span class="rank ${p.rank === 1 ? 'top-rank' : ''}">${p.rank ?? '—'}</span></td><td><div class="player-cell">${avatar(p.id)}<span>${escape(p.name)}</span></div></td><td>${p.played}</td><td>${p.wins}</td><td>${p.losses}</td><td>${p.diff > 0 ? '+' : ''}${p.diff}</td><td class="form-column"><span class="form-dots" aria-label="Recent form: ${
          p.form.length
            ? p.form
                .slice(-5)
                .map((x) => (x === 'W' ? 'win' : 'loss'))
                .join(', ')
            : 'no games'
        }">${Array.from({ length: 5 }, (_, i) => {
          const item = p.form.slice(-5)[i];
          return `<span class="form-dot ${item === 'W' ? 'win' : item === 'L' ? 'loss' : ''}">${item || '·'}</span>`;
        }).join('')}</span></td><td>${p.points}</td></tr>`,
    )
    .join('');
  $('#standings-note').textContent = summary.disputes
    ? `${summary.disputes} open concern(s). Standings are provisional; the final crown is held.`
    : 'Points → score difference → scores for → head-to-head for a two-way tie. Equal records share a rank.';
  const uncompleted = fixtures(state).filter((m) => m.status !== 'completed');
  const waitingForOpponent = uncompleted.find(
    (m) => (m.acceptedA && !m.acceptedB) || (!m.acceptedA && m.acceptedB),
  );
  const next =
    waitingForOpponent ||
    uncompleted.find((m) => m.status === 'queued') ||
    uncompleted[0];
  $('#next-match').innerHTML = next
    ? `<span class="eyebrow">${waitingForOpponent === next ? 'WAITING FOR OPPONENT PIN' : next.status === 'queued' ? 'QUEUED TO PLAY' : 'A MATCH STILL TO PLAY'}</span><h3>THE NEXT MOVE<br />IS YOURS.</h3><div class="next-pair">${escape(names(next.playerA))}<span>VERSUS</span>${escape(names(next.playerB))}</div><p class="next-note">${waitingForOpponent === next ? 'One player has accepted the charter. Opponent must enter their PIN to unlock posting.' : 'Arrange a time together. Both enter PIN to accept charter and post scoreboard.'}</p><button class="button button-dark" data-action="${next.acceptedA && next.acceptedB ? 'upload' : 'match-detail'}" data-pair="${escape(next.id)}">${next.acceptedA && next.acceptedB ? 'Post this result' : 'Enter PIN / Accept'} ${icon('arrow-up-right')}</button>`
    : `<span class="eyebrow">ALL MATCHUPS COMPLETE</span><h3>THAT'S A<br />SEASON.</h3><p class="next-note">${summary.disputes ? 'Review the reported concerns in the matchboard.' : 'Every pair has played. Relive the moments in the highlights.'}</p><a class="button button-dark" href="#clips">Watch the highlights ${icon('play')}</a>`;
  const playerFilter = $('#player-filter'),
    selected = playerFilter.value;
  playerFilter.innerHTML =
    '<option value="">All players</option>' +
    state.players
      .map((p) => `<option value="${escape(p.id)}">${escape(p.name)}</option>`)
      .join('');
  playerFilter.value = selected;
  $('#count-all').textContent = summary.total;
  $('#count-pending').textContent = summary.remaining;
  $('#count-done').textContent = summary.completed;
  renderMatches();
  renderPhone(state, { escape, avatar, names });
  renderPlayers();
  renderClips();
  renderSettingsPin();
  const crown = $('#crown-card');
  crown.classList.toggle('crowned', summary.champions.length > 0);
  crown.innerHTML = `<div class="crown-emblem">${icon('crown')}</div><span class="eyebrow">${summary.champions.length ? (summary.champions.length > 1 ? 'SHARED SEASON CHAMPIONS' : 'YOUR SEASON CHAMPION') : 'THE FINAL WORD'}</span><h2>${summary.champions.length ? summary.champions.map((p) => escape(p.name)).join(' &amp; ') : summary.disputes ? 'A FAIR FINISH COMES FIRST.' : 'A CROWN TO BE EARNED.'}</h2><p>${summary.champions.length ? 'Every matchup played. Every point earned from the posted results.' : summary.disputes ? 'Reported concerns must be withdrawn by their reporters before the crown can be awarded. Evidence stays open for everyone to review.' : 'The season winner appears when every matchup has a result. Until then, there is everything to play for.'}</p><span class="pill">${summary.champions.length ? icon('check') + ' SEASON COMPLETE' : summary.completed + ' / ' + summary.total + ' MATCHUPS COMPLETED'}</span>`;
}
function renderMatches() {
  if (!state) return;
  const player = $('#player-filter').value;
  $('#filter-summary').textContent = player ? names(player) : 'Filter matches';
  const matches = fixtures(state)
    .filter(
      (m) =>
        (filter === 'all' ||
          (filter === 'completed'
            ? m.status === 'completed'
            : m.status !== 'completed')) &&
        (!player || [m.playerA, m.playerB].includes(player)),
    )
    .sort((a, b) => {
      // Prioritize uncompleted matches waiting for 2nd PIN
      const aWaiting = a.status !== 'completed' && ((a.acceptedA && !a.acceptedB) || (!a.acceptedA && a.acceptedB));
      const bWaiting = b.status !== 'completed' && ((b.acceptedA && !b.acceptedB) || (!b.acceptedA && b.acceptedB));
      if (aWaiting && !bWaiting) return -1;
      if (!aWaiting && bWaiting) return 1;
      const aBoth = a.status !== 'completed' && a.acceptedA && a.acceptedB;
      const bBoth = b.status !== 'completed' && b.acceptedA && b.acceptedB;
      if (aBoth && !bBoth) return -1;
      if (!aBoth && bBoth) return 1;
      return 0;
    });
  $('#match-grid').innerHTML =
    (showAll ? matches : matches.slice(0, 6))
      .map((m) => {
        const done = m.status === 'completed',
          flagged = m.reports?.length,
          bothAgreed = !done && m.acceptedA && m.acceptedB,
          halfAgreed = !done && ((m.acceptedA && !m.acceptedB) || (!m.acceptedA && m.acceptedB));
        const statusLabel = flagged
          ? 'CONCERN REPORTED'
          : done
            ? 'COMPLETED'
            : bothAgreed
              ? 'READY TO POST'
              : halfAgreed
                ? 'WAITING OPPONENT'
                : m.status === 'queued'
                  ? 'QUEUED'
                  : 'TO PLAY';
        const statusClass = flagged ? 'flagged' : done ? 'done' : bothAgreed ? 'both-agreed' : halfAgreed ? 'half-agreed' : '';
        return `<article class="match-card ${halfAgreed ? 'card-waiting-opponent' : ''}"><div class="match-card-top"><button class="match-detail-link" data-action="match-detail" data-pair="${escape(m.id)}">Match details ${icon('chevron-down')}</button><span class="match-status ${statusClass}">${icon(flagged ? 'flag' : done ? 'check' : halfAgreed ? 'clock' : 'clock')}${statusLabel}</span></div><div class="match-players">${[m.playerA, m.playerB].map((id, i) => `<div class="match-player ${done && (i ? m.scoreB > m.scoreA : m.scoreA > m.scoreB) ? 'winner' : ''}">${avatar(id)}<span>${escape(names(id))}</span><strong>${done ? (i ? m.scoreB : m.scoreA) : '—'}</strong></div>`).join('')}</div><div class="match-card-bottom"><small>${done ? escape(m.map || 'Final result') + ' · ' + date(m.completedAt) : halfAgreed ? '1 player accepted · waiting for opponent' : bothAgreed ? 'Both players accepted charter' : 'Awaiting a final scoreboard'}</small><button class="text-link" data-action="${done ? 'evidence' : 'upload'}" data-pair="${escape(m.id)}">${done ? 'View result' : bothAgreed ? 'Post result' : 'Enter PIN'} ${icon('arrow-up-right')}</button></div></article>`;
      })
      .join('') ||
    '<div class="empty-card">No matchups in this view yet.</div>';
  $('#show-more').hidden = matches.length <= 6;
  $('#show-more').innerHTML =
    (showAll ? 'Show fewer matchups' : `Show all ${matches.length} matchups`) +
    icon('arrow-down');
}
function renderPlayers() {
  $('#player-grid').innerHTML = state.players
    .map((p) => {
      const left = remainingOpponents(state, p.id),
        played = state.players.length - 1 - left.length,
        total = state.players.length - 1;
      return `<article class="player-card"><div class="player-card-head">${avatar(p.id)}<div><strong>${escape(p.name)}</strong><small>${played === 0 ? 'No games posted yet' : left.length ? 'Still in the running' : 'All matchups completed'}</small></div></div><div class="player-progress"><span>${played} / ${total} MATCHUPS PLAYED</span><span>${total ? Math.round((played / total) * 100) : 0}%</span></div><div class="progress-track"><span style="width:${total ? (played / total) * 100 : 0}%"></span></div><p class="opponent-list">${left.length ? '<strong>Still to play:</strong> ' + left.map((p) => escape(p.name)).join(' · ') : 'All opponents played. Your scoreboards are in.'}</p><button class="text-link" data-action="reminder" data-player="${escape(p.id)}">${icon('copy')} Copy match reminder</button></article>`;
    })
    .join('');
}
function renderClips() {
  const grid = $('#clip-grid');
  if (!state.clips.length) return;
  grid.querySelector('.clip-empty')?.remove();
  for (const clip of [...state.clips].reverse()) {
    let card = document.getElementById('clip-' + clip.id);
    if (!card) {
      card = document.createElement('article');
      card.id = 'clip-' + clip.id;
      card.className = 'clip-card';
      card.innerHTML = `<video controls playsinline preload="none" src="${escape(endpoint('video', { id: clip.id }))}" aria-label="${escape(clip.title)}"></video><div class="clip-meta"><h3>${escape(clip.title)}</h3><p>${escape(names(clip.playerId))} · ${date(clip.createdAt)}</p><div class="reactions" aria-label="React to gameplay"></div></div>`;
      grid.append(card);
    }
    card.querySelector('.reactions').innerHTML = REACTIONS.map(
      (r) =>
        `<button class="reaction" data-action="react" data-clip="${escape(clip.id)}" data-reaction="${r}" aria-label="${r === 'fire' ? 'Fire' : r === 'clutch' ? 'Clutch' : 'Good game'}: ${clip.reactions[r]}" aria-pressed="${clip.myReaction === r}">${icon(r)}<span>${r === 'gg' ? 'GG' : r === 'clutch' ? 'Clutch' : 'Fire'}</span> ${clip.reactions[r]}</button>`,
    ).join('');
  }
}

function openModal(title, html, kicker = 'SOLO LEAGUE', options = {}) {
  if (saving) return;
  releasePreview();
  modalVersion++;
  $('#modal-title').textContent = title;
  $('#modal-kicker').textContent = kicker;
  modal.dataset.flow = options.flow || '';
  postStep(options.step || 0);
  content.innerHTML = html;
  if (!modal.open) showSheet(modal);
  modal.scrollTop = 0;
}
function releasePreview() {
  if (previewURL) {
    URL.revokeObjectURL(previewURL);
    previewURL = null;
  }
}
function closeModal() {
  if (saving) return;
  activeCharterMatchId = null;
  modalVersion++;
  const closing = hideSheet(modal);
  releasePreview();
  return closing;
}
function setSaving(value) {
  saving = value;
  $('#modal-close').disabled = value;
  content.querySelectorAll('button[type=submit]').forEach((b) => {
    b.disabled = value;
    if (value) {
      b.dataset.idleLabel = b.innerHTML;
      b.textContent = 'Saving…';
    } else if (b.dataset.idleLabel) {
      b.innerHTML = b.dataset.idleLabel;
      delete b.dataset.idleLabel;
    }
  });
  content.setAttribute('aria-busy', String(value));
  for (const input of content.querySelectorAll(
    'input, select, textarea, button:not([type=submit])',
  )) {
    if (value && !input.disabled) {
      input.dataset.saveDisabled = 'true';
      input.disabled = true;
    } else if (!value && input.dataset.saveDisabled) {
      input.disabled = false;
      delete input.dataset.saveDisabled;
    }
  }
  if (modal.dataset.flow === 'post')
    postStep(
      content.querySelector('#confirm-form') || value ? 3 : 2,
      value ? 'SAVING…' : '',
    );
}
function formError(form, message) {
  feedback('error');
  const error = form.querySelector('.form-error');
  error.textContent = message;
  error.hidden = false;
  error.scrollIntoView({ block: 'nearest' });
}
function errorMarkup() {
  return '<div class="form-error" role="alert" hidden></div>';
}
function playerOptions(selected = '') {
  return (
    '<option value="">Select player</option>' +
    state.players
      .map(
        (p) =>
          `<option value="${escape(p.id)}" ${p.id === selected ? 'selected' : ''}>${escape(p.name)}</option>`,
      )
      .join('')
  );
}
async function saveForm(form, action, values, success) {
  if (!navigator.onLine) {
    formError(
      form,
      'You are offline. Keep this draft and reconnect before posting.',
    );
    return;
  }
  setSaving(true);
  form.querySelector('.form-error').hidden = true;
  try {
    let response;
    try {
      response = await api(action, values);
    } catch (error) {
      if (
        action !== 'result' ||
        !values.submissionId ||
        (error.status && error.status < 500)
      )
        throw error;
      toast('Checking your save. Keep this page open.');
      if (action === 'result') postStep(3, 'VERIFYING YOUR SAVE…');
      response = await api(action, values);
    }
    if (action === 'result') postStep(3, 'VERIFYING…');
    const synced = await refresh(false, true);
    if (action === 'result') {
      draft = null;
      draftRevision++;
      draftDurable = false;
      await clearDraft();
      showDraft();
    }
    setSaving(false);
    if (action === 'result') {
      if (synced) connection('updated');
      feedback('saved');
      savedResultModal(values, response, synced);
    } else {
      closeModal();
      toast(success || response.message);
    }
  } catch (e) {
    setSaving(false);
    formError(form, e.message);
    if (e.status === 409) await refresh();
  }
}

function savedResultModal(values, receipt, synced) {
  openModal(
    'RESULT LOCKED.',
    `<div class="save-receipt"><div class="receipt-mark">${icon('check')}</div><h3>It's on the record.</h3><p>Your result is saved for everyone.<br />Refreshing or closing this page won't remove it.</p><div class="receipt-score">${values.scoreA} <span>—</span> ${values.scoreB}</div><div class="receipt-players">${escape(names(values.playerA))} vs ${escape(names(values.playerB))}</div><div class="receipt-id">${receipt.savedAt ? 'Confirmed ' + escape(new Date(receipt.savedAt).toLocaleString()) : 'Saved to the shared league'}${receipt.receiptId ? '<br />Receipt ' + escape(receipt.receiptId) : ''}${synced ? '' : '<br />The table will sync when the connection recovers.'}</div><div class="receipt-actions"><button class="button button-dark" id="receipt-done">Done ${icon('check')}</button><button class="button button-outline" id="receipt-view-match">View match ${icon('arrow-up-right')}</button></div><a class="text-link" target="_blank" rel="noopener" href="${escape(endpoint('evidence', { id: values.evidenceId }))}">Open original scoreboard ${icon('image')}</a></div>`,
    '✓ RESULT LOCKED',
    { flow: 'post', step: 4 },
  );
  $('#receipt-view-match').addEventListener('click', async () => {
    const id = pairKey(values.playerA, values.playerB);
    if (!state.matches.some((m) => m.id === id)) await refresh(false, true);
    if (state.matches.some((m) => m.id === id)) evidenceModal(id);
    else toast('Your result is saved. Reconnect to load its match details.');
  });
  $('#receipt-done').addEventListener('click', async () => {
    await closeModal();
    $('#league').scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
      block: 'start',
    });
  });
}

function uploadModal(pair = '') {
  if (pair) {
    const match = fixtures(state).find((m) => m.id === pair);
    if (match && (!match.acceptedA || !match.acceptedB)) {
      matchDetailModal(pair);
      toast('Both players must enter their PIN to accept the match charter before posting results.', true);
      return;
    }
  } else {
    // Check if there are any matches where both players have agreed
    const agreedMatches = fixtures(state).filter(
      (m) => m.status !== 'completed' && m.acceptedA && m.acceptedB,
    );
    if (agreedMatches.length === 0) {
      openModal(
        'PIN AGREEMENT REQUIRED.',
        `<div class="charter-locked-dialog"><div class="charter-accept-icon">${icon('lock')}</div><h3>NO CONFIRMED MATCHES YET</h3><p>Before posting a final scoreboard, both players must open their matchup on the <strong>Matchboard</strong> and enter their 6-digit PIN to agree to the match charter.</p><div class="form-actions"><button class="button button-dark" id="go-to-matches">Go to Matchboard ${icon('target')}</button></div></div>`,
        'AGREEMENT REQUIRED',
      );
      $('#go-to-matches')?.addEventListener('click', () => {
        closeModal();
        const matchesSection = $('#matches');
        if (matchesSection) matchesSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        location.hash = '#matches';
      });
      return;
    }
  }
  openModal(
    'POST YOUR SCOREBOARD.',
    `<p class="modal-intro">Upload a clear, final 1v1 scoreboard. We'll read the text, then you'll check the players and scores before posting.</p><label class="dropzone" id="score-drop">${icon('scan')}<strong>Drop your scoreboard here</strong><span>or tap to choose a screenshot<br />PNG, JPG or WebP · up to 4 MB</span><input id="score-file" type="file" accept="image/png,image/jpeg,image/webp" aria-label="Choose scoreboard screenshot" /></label><div class="upload-steps"><span class="upload-step"><b>1</b> Upload screenshot</span><span class="upload-step"><b>2</b> Check details</span><span class="upload-step"><b>3</b> Post result</span></div><p class="fine-print">Only upload a real final scoreboard. Images and any corrections are public. One official result per matchup; posted results cannot be overwritten.</p>`,
    'YOUR GAME. YOUR RECEIPT.',
    { flow: 'post', step: 1 },
  );
  if (draft)
    content.insertAdjacentHTML(
      'afterbegin',
      '<div class="draft-offer"><span>You have an unfinished scoreboard.</span><button class="text-link" data-action="resume">Resume draft</button></div>',
    );
  const input = $('#score-file'),
    drop = $('#score-drop');
  input.addEventListener(
    'change',
    () => input.files[0] && readScreenshot(input.files[0], pair),
  );
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('dragging');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    if (e.dataTransfer.files[0])
      void readScreenshot(e.dataTransfer.files[0], pair);
  });
}
async function readScreenshot(file, pair) {
  if (
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
    file.size > 4_000_000 ||
    !file.size
  ) {
    toast('Choose a PNG, JPG or WebP screenshot under 4 MB.', true);
    return;
  }
  draft = {
    file,
    pair,
    submissionId: crypto.randomUUID(),
    values: {},
    createdAt: Date.now(),
  };
  void persistDraft();
  const version = modalVersion,
    form = new FormData();
  form.append('screenshot', file);
  releasePreview();
  previewURL = URL.createObjectURL(file);
  content.innerHTML =
    '<div class="busy-panel"><div class="spinner"></div><h3>READING THE SCOREBOARD.</h3><p>Finding names and scores. This may take a moment.</p><p class="fine-print">Nothing is posted until you review and submit it.</p></div>';
  try {
    const result = await api('extract', form, { timeout: 90_000 });
    if (draft?.file === file) {
      draft.result = result;
      draft.extractedAt = Date.now();
      await persistDraft();
    }
    if (version !== modalVersion || !modal.open) return;
    reviewScreenshot(result, pair);
  } catch (error) {
    if (version !== modalVersion || !modal.open) return;
    content.innerHTML = `<div class="notice notice-error">${escape(error.message)}</div><button class="button button-dark" id="retry-image">Choose another image ${icon('upload')}</button>`;
    $('#retry-image').addEventListener('click', () => uploadModal(pair));
  }
}
function reviewScreenshot(result, pair) {
  const submissionId = draft?.submissionId || crypto.randomUUID();
  postStep(2);
  modal.scrollTop = 0;
  const extracted = result.extraction,
    candidates = extracted.candidates,
    match = fixtures(state).find((m) => m.id === pair);
  const a = candidates[0]?.playerId || match?.playerA || '',
    b = candidates[1]?.playerId || match?.playerB || '';
  $('#modal-title').textContent = 'CHECK. THEN POST.';
  content.innerHTML = `<p class="modal-intro">Compare every field with your final scoreboard. Select existing players even if their in-game spelling differs.</p><div class="review-grid"><div><img class="review-image" src="${escape(previewURL)}" alt="Your uploaded scoreboard for review" /><p class="review-caption">Original image · text confidence ${extracted.confidence}%<br />Text confidence does not verify that a match is authentic.</p><details class="ocr-details"><summary>View extracted text</summary><pre>${escape(extracted.rawText)}</pre></details></div><form id="result-form">${extracted.warnings.length ? `<div class="notice"><ul>${extracted.warnings.map((w) => `<li>${escape(w)}</li>`).join('')}</ul></div>` : ''}<div class="score-row"><label class="field"><span>Player A</span><select name="playerA" required>${playerOptions(a)}</select></label><label class="field"><span>Score</span><input name="scoreA" type="number" min="0" max="6" step="1" inputmode="numeric" required value="${candidates[0]?.score ?? ''}" aria-label="Player A score" /></label></div><div class="score-row"><label class="field"><span>Player B</span><select name="playerB" required>${playerOptions(b)}</select></label><label class="field"><span>Score</span><input name="scoreB" type="number" min="0" max="6" step="1" inputmode="numeric" required value="${candidates[1]?.score ?? ''}" aria-label="Player B score" /></label></div><label class="field"><span>Map / mode (optional)</span><input name="map" maxlength="40" value="${escape(extracted.map)}" placeholder="As shown in the game" /></label><label class="field" id="correction-field" hidden><span>Explain the OCR corrections</span><textarea name="correctionNote" minlength="8" maxlength="300" placeholder="What was read incorrectly? Point to the correct name or final score in the image."></textarea><small>This note stays visible beside the original screenshot.</small></label><div id="pair-check" class="notice" hidden></div>${errorMarkup()}<div class="form-actions"><button type="button" class="text-link" id="change-image">Change image</button><button type="submit" class="button button-dark">Continue ${icon('arrow-up-right')}</button></div></form></div>`;
  const form = $('#result-form'),
    field = (name) => form.elements.namedItem(name);
  if (draft?.result?.id === result.id)
    for (const [name, value] of Object.entries(draft.values || {})) {
      const input = field(name);
      if (input && name !== 'attested') input.value = value;
    }
  function checkReview() {
    const corrected =
      candidates.length !== 2 ||
      candidates[0]?.playerId !== field('playerA').value ||
      candidates[1]?.playerId !== field('playerB').value ||
      String(candidates[0]?.score ?? '') !== field('scoreA').value ||
      String(candidates[1]?.score ?? '') !== field('scoreB').value;
    $('#correction-field').hidden = !corrected;
    field('correctionNote').required = corrected;
    const check = $('#pair-check');
    check.hidden = true;
    const a = field('playerA').value,
      b = field('playerB').value;
    if (a && b) {
      if (a === b) {
        check.textContent = 'Choose two different players.';
        check.hidden = false;
      } else {
        const pk = pairKey(a, b);
        const m = state.matches.find((mm) => mm.id === pk);
        if (!m || !m.acceptedA || !m.acceptedB) {
          check.textContent = 'Both players must enter their PIN to accept the match charter before this result can be posted.';
          check.hidden = false;
        }
      }
    }
  }
  function retainReview() {
    checkReview();
    if (draft) {
      draft.values = Object.fromEntries(new FormData(form));
      void persistDraft();
    }
  }
  form.addEventListener('input', retainReview);
  form.addEventListener('change', retainReview);
  checkReview();
  $('#change-image').addEventListener('click', () => {
    if (!saving) uploadModal(pair);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;
    const values = Object.fromEntries(new FormData(form));
    values.scoreA = Number(values.scoreA);
    values.scoreB = Number(values.scoreB);
    try {
      validateScores(values.scoreA, values.scoreB);
      pairKey(values.playerA, values.playerB);
      if (!$('#pair-check').hidden) throw Error($('#pair-check').textContent);
    } catch (error) {
      formError(form, error.message);
      return;
    }
    if (draft) {
      draft.values = values;
      await persistDraft();
    }
    confirmResult(values, result, pair, submissionId);
  });
}
function confirmResult(values, result, pair, submissionId) {
  postStep(3);
  $('#modal-title').textContent = 'MAKE IT OFFICIAL.';
  content.innerHTML = `<div class="confirm-result"><span class="eyebrow">ONE FINAL RECORD</span><div class="receipt-score">${values.scoreA} <span>—</span> ${values.scoreB}</div><p class="receipt-players">${escape(names(values.playerA))} vs ${escape(names(values.playerB))}</p>${values.map ? `<p class="confirm-map">${escape(values.map)}</p>` : ''}<details class="confirm-proof"><summary>Compare with the screenshot ${icon('chevron-down')}</summary><img class="review-image" src="${escape(previewURL)}" alt="Your final scoreboard" /></details></div><form id="confirm-form"><label class="check-field"><input name="attested" type="checkbox" required /><span>This is a real, unedited final scoreboard. Both players and scores are correct. This result will be public and cannot be overwritten.</span></label>${errorMarkup()}<div class="form-actions"><button type="button" class="text-link" id="edit-review">Edit details</button><button type="submit" class="button button-dark">Post result ${icon('check')}</button></div><p class="fine-print">Saved only after confirmation from the league. Retrying keeps the same submission ID.</p></form>`;
  modal.scrollTop = 0;
  $('#edit-review').addEventListener('click', () =>
    reviewScreenshot(result, pair),
  );
  $('#confirm-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving) return;
    await saveForm(event.currentTarget, 'result', {
      ...values,
      attested: event.currentTarget.elements.attested.checked,
      evidenceId: result.id,
      receipt: result.receipt,
      submissionId,
    });
  });
}

async function resumeDraft() {
  if (!draft) return;
  const previous = state.matches.find(
    (m) => m.status === 'completed' && m.evidenceId === draft.result?.id,
  );
  if (previous) {
    draft = null;
    await clearDraft();
    showDraft();
    savedResultModal(
      previous,
      { savedAt: previous.completedAt, receiptId: previous.receiptId },
      true,
    );
    return;
  }
  const current = draft;
  openModal('YOUR SCOREBOARD.', '', 'DRAFT RESTORED', {
    flow: 'post',
    step: 2,
  });
  previewURL = URL.createObjectURL(current.file);
  if (current.result && Date.now() - current.extractedAt < 55 * 60 * 1000)
    reviewScreenshot(current.result, current.pair);
  else await readScreenshot(current.file, current.pair);
}
function playerDetailModal(id) {
  const player = standings(state).find((p) => p.id === id);
  if (!player) return;
  const rawPlayer = state.players.find((p) => p.id === id);
  const opponents = remainingOpponents(state, id);
  const myPlayerId = state.myPlayerId;
  const isMine = rawPlayer?.isMyPlayer || (!myPlayerId && rawPlayer?.pinOwned && !rawPlayer?.claimedByOther);
  const myPlayerName = myPlayerId ? names(myPlayerId) : null;

  let pinActionHtml = '';
  if (isMine) {
    pinActionHtml = `<div class="player-pin-actions"><button class="button button-dark button-sm pin-reset-btn" id="get-pin-btn">${icon('lock')} View My Active PIN</button><button class="text-link" id="reset-pin-btn" style="font-size: 11px; margin-top: 6px;">Generate New PIN</button></div>`;
  } else if (myPlayerId && myPlayerId !== id) {
    pinActionHtml = `<p class="fine-print" style="color: #f3b218;">${icon('lock')} Your device is registered as <strong>${escape(myPlayerName)}</strong>. You can only view and manage your own PIN.</p>`;
  } else {
    pinActionHtml = `<p class="fine-print" style="color: #f87171;">${icon('lock')} PIN already generated for this player. Contact admin if this is your name.</p>`;
  }

  openModal(
    names(id),
    `<div class="player-detail-sheet">${avatar(id)}<div class="player-detail-rank">${player.rank ? 'Rank ' + player.rank : 'Yet to play'} · ${player.points} points</div><div class="rank-detail"><dl><div><dt>Played</dt><dd>${player.played}</dd></div><div><dt>Wins</dt><dd>${player.wins}</dd></div><div><dt>Losses</dt><dd>${player.losses}</dd></div><div><dt>Difference</dt><dd>${player.diff > 0 ? '+' : ''}${player.diff}</dd></div></dl><p>Scores: ${player.for} for · ${player.against} against</p><p>Recent form: ${
      player.form.length
        ? player.form
            .slice(-5)
            .map((f) => (f === 'W' ? 'Win' : 'Loss'))
            .join(' · ')
        : 'No results yet'
    }</p></div><h3>Still to play</h3><p>${opponents.length ? opponents.map((p) => escape(p.name)).join(' · ') : 'Every opponent played.'}</p><button class="button button-dark" data-action="reminder" data-player="${escape(id)}">Copy a match reminder ${icon('copy')}</button>${pinActionHtml}</div>`,
    'PLAYER RECORD',
  );
  const getBtn = document.getElementById('get-pin-btn');
  const resetBtn = document.getElementById('reset-pin-btn');
  const fetchPin = async (forceReset = false, btn = getBtn) => {
    if (saving) return;
    if (btn) btn.disabled = true;
    try {
      const response = await api('reveal-pin', { playerId: id, forceReset });
      if (response.pin) {
        pinRevealModal(names(id), response.pin);
      }
    } catch (err) {
      if (btn) btn.disabled = false;
      toast(err.message, true);
    }
  };
  getBtn?.addEventListener('click', () => fetchPin(false, getBtn));
  resetBtn?.addEventListener('click', () => fetchPin(true, resetBtn));
}

function filtersModal() {
  const selected = $('#player-filter').value;
  openModal(
    'Find your matchup.',
    `<form id="filters-form"><label class="field"><span>Match status</span><select name="status"><option value="all">All matches</option><option value="pending">Still to play</option><option value="completed">Completed</option></select></label><label class="field"><span>Player</span><select name="player"><option value="">Whole league</option>${state.players.map((p) => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('')}</select></label><div class="form-actions"><button class="text-link" id="reset-filters" type="button">Reset</button><button class="button button-dark" type="submit">Show matches ${icon('check')}</button></div></form>`,
    'MATCH FILTERS',
  );
  const form = $('#filters-form');
  form.elements.status.value = filter;
  form.elements.player.value = selected;
  $('#reset-filters').addEventListener('click', () => {
    form.elements.status.value = 'all';
    form.elements.player.value = '';
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    filter = form.elements.status.value;
    $('#player-filter').value = form.elements.player.value;
    showAll = false;
    document.querySelectorAll('[data-filter]').forEach((b) => {
      const active = b.dataset.filter === filter;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    renderMatches();
    feedback('selection');
    await closeModal();
    $('#matches').scrollIntoView({ block: 'start' });
  });
}
function charterSlotHtml(playerId, accepted, side) {
  const playerName = escape(names(playerId));
  if (accepted) {
    return `<div class="charter-slot charter-accepted"><span class="charter-slot-check">${icon('check')}</span><strong>${playerName}</strong><small>Accepted ${new Date(accepted).toLocaleDateString()}</small><span class="pill" style="font-size:10px;color:#4caf50;border-color:rgba(76,175,80,0.3);margin-top:4px;">LOCKED IN</span></div>`;
  }
  const myPlayerId = state?.myPlayerId;
  const isOpponentSlot = myPlayerId && myPlayerId !== playerId;
  if (isOpponentSlot) {
    return `<div class="charter-slot charter-pending charter-opponent-locked"><strong>${playerName}</strong><small>Opponent device required</small><div class="opponent-lock-badge" style="display:flex;align-items:center;justify-content:center;gap:6px;padding:10px 8px;border-radius:8px;background:rgba(255,255,255,0.04);border:1px dashed rgba(255,255,255,0.15);font-size:11px;color:#aaa;margin-top:6px;">${icon('lock')} <span>Awaiting PIN on ${playerName}'s phone</span></div></div>`;
  }
  let savedPin = '';
  try {
    const rawPl = state?.players?.find((p) => p.id === playerId);
    savedPin = rawPl?.myPin || localStorage.getItem('player-pin-' + playerId) || '';
  } catch {}
  return `<div class="charter-slot charter-pending"><strong>${playerName}</strong><small>Enter your 6-digit PIN</small><form class="charter-pin-form" data-player="${escape(playerId)}" data-side="${side}"><div class="pin-input-wrap"><input class="pin-input" name="pin" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" minlength="6" placeholder="6-digit PIN" value="${savedPin}" autocomplete="off" required aria-label="Enter ${playerName}'s PIN" />${savedPin ? `<button type="button" class="pin-quick-btn auto-fill-pin" title="Use saved PIN">${icon('check')}</button>` : `<button type="button" class="pin-quick-btn paste-pin" title="Paste PIN">${icon('copy')}</button>`}</div><button class="button button-dark button-sm" type="submit">Accept ${icon('lock')}</button>${errorMarkup()}</form></div>`;
}
function matchDetailModal(id) {
  const m = fixtures(state).find((m) => m.id === id);
  if (!m) return;
  if (m.status === 'completed') {
    evidenceModal(id);
    return;
  }
  activeCharterMatchId = id;
  const bothAccepted = Boolean(m.acceptedA && m.acceptedB);
  openModal(
    'YOUR NEXT MATCH.',
    `<div class="pending-detail"><div class="hub-versus"><div>${avatar(m.playerA)}<strong>${escape(names(m.playerA))}</strong></div><span>vs</span><div>${avatar(m.playerB)}<strong>${escape(names(m.playerB))}</strong></div></div><span class="pill">${m.status === 'queued' ? 'QUEUED' : 'STILL TO PLAY'}</span><p>One official match between these players. Both must enter their PIN to unlock posting.</p>${bothAccepted ? `<button class="button button-dark" data-action="upload" data-pair="${escape(id)}">Post this match ${icon('upload')}</button>` : `<div class="charter-locked-notice">${icon('lock')} <span>Both players must enter their PIN below before results can be posted.</span></div>`}</div><div class="charter-accept-section"><div class="charter-accept-header"><span class="charter-accept-icon">${icon('crown')}</span><h3>MATCH CHARTER</h3><p>No rematch. No replay for connection issues. The final scoreboard is the record.</p></div>${bothAccepted ? `<div class="charter-both-agreed"><span class="charter-agreed-badge">${icon('check')} BOTH PLAYERS AGREED</span><p style="font-size:13px;color:#a5d6a7;margin:4px 0 12px;font-weight:600;">Match charter verified by both players. Posting unlocked!</p><small>Player A: ${new Date(m.acceptedA).toLocaleDateString()} · Player B: ${new Date(m.acceptedB).toLocaleDateString()}</small><button class="button button-dark charter-unlocked-cta" data-action="upload" data-pair="${escape(id)}">Upload scoreboard result now ${icon('upload')}</button></div>` : `<div class="charter-slots-accept">${charterSlotHtml(m.playerA, m.acceptedA, 'A')}${charterSlotHtml(m.playerB, m.acceptedB, 'B')}</div><p class="fine-print">Each player enters their private 6-digit PIN. To view or generate your unique PIN, tap your name in <strong>Standings</strong>. PINs automatically cycle each match for privacy.</p>`}</div>`,
    'ONE MATCH PER PAIR',
  );
  content.querySelectorAll('.charter-pin-form').forEach((form) => {
    const pinInput = form.querySelector('.pin-input');
    form.querySelector('.paste-pin')?.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        const clean = text.trim().slice(0, 6);
        if (clean && /^\d+$/.test(clean)) {
          pinInput.value = clean;
          toast('PIN pasted from clipboard!');
        } else {
          toast('Copied text was not a valid PIN.');
        }
      } catch {
        pinInput.focus();
      }
    });
    form.querySelector('.auto-fill-pin')?.addEventListener('click', () => {
      const pid = form.dataset.player;
      const saved = localStorage.getItem('player-pin-' + pid);
      if (saved) {
        pinInput.value = saved;
        toast('Autofilled saved PIN!');
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (saving) return;
      const playerId = form.dataset.player;
      const pin = new FormData(form).get('pin');
      if (!pin || pin.length !== 6) {
        formError(form, 'Enter your 6-digit PIN.');
        return;
      }
      setSaving(true);
      form.querySelector('.form-error').hidden = true;
      try {
        await api('accept-charter', { matchId: id, playerId, pin });
        try {
          localStorage.setItem('player-pin-' + playerId, pin);
        } catch {}
        await refresh(false, true);
        setSaving(false);
        feedback('saved');
        const updated = fixtures(state).find((item) => item.id === id);
        if (updated && updated.acceptedA && updated.acceptedB) {
          toast('Both players agreed! Scoreboard upload unlocked.');
          uploadModal(id);
        } else {
          matchDetailModal(id);
          toast('PIN verified. Awaiting opponent agreement.');
        }
      } catch (err) {
        setSaving(false);
        formError(form, err.message);
      }
    });
  });
}

function scheduleModal() {
  openModal(
    'PICK YOUR MATCHUP.',
    `<p class="modal-intro">Enter two roster names. A queued match is a reminder to play; it only counts after a final scoreboard is posted.</p><form id="schedule-form"><datalist id="roster-options">${state.players.map((p) => `<option value="${escape(p.name)}"></option>`).join('')}</datalist><div class="two-fields"><label class="field"><span>Player A</span><input name="a" list="roster-options" placeholder="Player name" required autocomplete="off" /></label><label class="field"><span>Player B</span><input name="b" list="roster-options" placeholder="Opponent name" required autocomplete="off" /></label></div><p class="fine-print">A vs B and B vs A are the same matchup. Choose the existing roster player for alternate spellings.</p>${errorMarkup()}<div class="form-actions"><button type="button" class="text-link" data-action="player">Add a missing player</button><button class="button button-dark" type="submit">Queue matchup ${icon('plus')}</button></div></form>`,
  );
  $('#schedule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;
    const form = e.currentTarget,
      data = new FormData(form);
    const a = state.players.find(
        (p) => normalizeName(p.name) === normalizeName(data.get('a')),
      ),
      b = state.players.find(
        (p) => normalizeName(p.name) === normalizeName(data.get('b')),
      );
    if (!a || !b) {
      formError(
        form,
        'Choose two existing roster players. Add a missing participant before the first result.',
      );
      return;
    }
    await saveForm(form, 'schedule', { playerA: a.id, playerB: b.id });
  });
}
function playerModal() {
  if (leagueSummary(state).rosterLocked) {
    openModal(
      'THE ROSTER IS LOCKED.',
      '<p class="modal-intro">The first result has been posted. Keeping the same roster gives everyone the same opponents and a fixed finish line. Select an existing player when a screenshot uses a different spelling.</p>',
    );
    return;
  }
  openModal(
    'BRING A PLAYER IN.',
    `<p class="modal-intro">Add a real participant before the first result. Every new player gets one matchup with everyone in the league.</p><form id="player-form"><label class="field"><span>Player name</span><input name="name" required minlength="2" maxlength="32" autocomplete="off" placeholder="In-game player name" /><small>Do not add alternate spellings of an existing player.</small></label>${errorMarkup()}<div class="form-actions"><span class="fine-print">The roster locks after the first result.</span><button class="button button-dark" type="submit">Add player ${icon('plus')}</button></div></form>`,
  );
  $('#player-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;
    const form = e.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    if (!navigator.onLine) {
      formError(form, 'You are offline. Reconnect before adding a player.');
      return;
    }
    setSaving(true);
    form.querySelector('.form-error').hidden = true;
    try {
      const response = await api('player', values);
      await refresh(false, true);
      setSaving(false);
      if (response.pin) {
        pinRevealModal(values.name, response.pin);
      } else {
        closeModal();
        toast(response.message);
      }
    } catch (err) {
      setSaving(false);
      formError(form, err.message);
      if (err.status === 409) await refresh();
    }
  });
}
function pinRevealModal(playerName, pin) {
  feedback('saved');
  const playerId = normalizeName(playerName);
  openModal(
    'SAVE THIS PIN.',
    `<div class="pin-reveal"><div class="pin-reveal-icon">${icon('crown')}</div><h3>${escape(playerName)}'s Private PIN</h3><p>Use this <strong>6-digit PIN</strong> to accept match charters. Save it or keep it on this device.</p><div class="pin-code" id="revealed-pin-display" data-pin="${pin}" aria-label="Player PIN">${pin.split('').map((d) => `<span>${d}</span>`).join('')}</div><div class="pin-reveal-actions"><button type="button" class="button button-outline button-sm" id="copy-pin-btn">${icon('copy')} Copy PIN</button><button type="button" class="button button-dark button-sm" id="save-pin-device-btn">${icon('check')} Save to this device</button></div><div class="pin-warning">${icon('lock')} Stored securely. Only share with <strong>${escape(playerName)}</strong></div><button class="button button-dark" id="pin-done">Done ${icon('check')}</button></div>`,
    'PLAYER PIN',
  );
  try {
    localStorage.setItem('player-pin-' + playerId, pin);
    localStorage.setItem('my-player-id', playerId);
  } catch {}
  $('#copy-pin-btn')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pin);
      toast('PIN copied to clipboard: ' + pin);
    } catch {
      toast('PIN: ' + pin);
    }
  });
  $('#save-pin-device-btn')?.addEventListener('click', () => {
    try {
      localStorage.setItem('player-pin-' + playerId, pin);
      localStorage.setItem('my-player-id', playerId);
      toast('PIN saved to this device for auto-fill!');
    } catch {}
  });
  $('#pin-done').addEventListener('click', () => {
    closeModal();
    toast(`${playerName}'s PIN is locked in.`);
  });
}
function reminderModal(id = '') {
  openModal(
    'KEEP THE LOBBY MOVING.',
    `<p class="modal-intro">A copyable reminder built from the latest loaded results. Share it with your squad whenever you're ready.</p><label for="reminder-text" class="sr-only">Match reminder</label><textarea id="reminder-text" class="reminder-text" readonly>${escape(reminder(state, id))}</textarea><div class="form-actions"><span class="fine-print">Nothing is sent automatically.</span><button id="copy-reminder" class="button button-dark">Copy reminder ${icon('copy')}</button></div>`,
    'WHO STILL NEEDS TO PLAY?',
  );
  $('#copy-reminder').addEventListener('click', async () => {
    const textarea = $('#reminder-text');
    try {
      await navigator.clipboard.writeText(textarea.value);
      feedback('copied');
      toast('Match reminder copied.');
    } catch {
      textarea.focus();
      textarea.select();
      toast('Reminder selected. Use your device’s Copy command.');
    }
  });
}
function evidenceModal(id) {
  const m = state.matches.find((m) => m.id === id && m.status === 'completed');
  if (!m) return;
  openModal(
    'THE RESULT. THE RECEIPT.',
    `<div class="evidence-heading"><span>${escape(names(m.playerA))}<br />${escape(names(m.playerB))}</span><strong>${m.scoreA} — ${m.scoreB}</strong></div><div class="review-grid"><div><a href="${escape(endpoint('evidence', { id: m.evidenceId }))}" target="_blank" rel="noopener"><img class="review-image" src="${escape(endpoint('evidence', { id: m.evidenceId }))}" alt="Original scoreboard for ${escape(names(m.playerA))} versus ${escape(names(m.playerB))}" /></a><p class="review-caption">Tap the image to see the original.<br />Posted ${escape(new Date(m.completedAt).toLocaleString())}${m.map ? ' · ' + escape(m.map) : ''}${m.receiptId ? '<br />Receipt ' + escape(m.receiptId) : ''}</p><button class="text-link" data-action="receipt" data-pair="${escape(m.id)}">Open saved receipt ${icon('check')}</button></div><div><div class="notice">Community-posted result. The image is evidence for everyone to review; OCR does not verify authenticity.</div>${m.corrected ? `<div class="notice"><strong>Uploader's OCR correction</strong><p>${escape(m.correctionNote)}</p></div>` : '<p class="fine-print">The submitted names and scores matched the extracted fields.</p>'}${(m.reports || []).map((r) => `<div class="evidence-report">${icon('flag')} ${escape(r.reason)}<br /><small>Reported ${date(r.createdAt)}</small>${r.mine ? `<button class="text-link" data-withdraw="${escape(r.id)}">Withdraw my report</button>` : ''}</div>`).join('')}<form id="report-form"><label class="field"><span>Something doesn't match?</span><textarea name="reason" required minlength="12" maxlength="400" placeholder="Describe the concern and point to the evidence."></textarea></label><p class="fine-print">Open reports hold the final crown. Only the reporting browser can withdraw its report.</p>${errorMarkup()}<div class="form-actions"><button class="button button-outline" type="submit">Report concern ${icon('flag')}</button></div></form></div></div>`,
  );
  $('#report-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!saving)
      void saveForm(e.currentTarget, 'report', {
        matchId: id,
        reason: new FormData(e.currentTarget).get('reason'),
      });
  });
  content.querySelectorAll('[data-withdraw]').forEach((button) =>
    button.addEventListener('click', async () => {
      if (saving) return;
      setSaving(true);
      button.disabled = true;
      try {
        await api('withdraw-report', {
          matchId: id,
          reportId: button.dataset.withdraw,
        });
        await refresh();
        setSaving(false);
        evidenceModal(id);
        toast('Your report was withdrawn.');
      } catch (e) {
        setSaving(false);
        button.disabled = false;
        toast(e.message, true);
      }
    }),
  );
}
function videoModal() {
  openModal(
    'GIVE THE LOBBY A REPLAY.',
    `<p class="modal-intro">Share your own gameplay, then let the squad react. MP4 or WebM, up to 20 MB.</p><form id="video-form"><label class="field"><span>Gameplay video</span><input name="file" type="file" accept="video/mp4,video/webm" required /></label><div class="two-fields"><label class="field"><span>Clip title</span><input name="title" required minlength="3" maxlength="80" placeholder="Give the moment a name" /></label><label class="field"><span>Player</span><select name="playerId" required>${playerOptions()}</select></label></div><label class="check-field"><input name="permission" type="checkbox" required /><span>This is my gameplay and I have permission to share it publicly.</span></label><div id="video-progress" class="video-progress" hidden><span id="video-status"></span><progress max="100" value="0" aria-label="Video upload progress"></progress></div>${errorMarkup()}<div class="form-actions"><span class="fine-print">Reactions never affect standings.</span><button class="button button-dark" type="submit">Upload gameplay ${icon('upload')}</button></div></form>`,
    'SAVE THE MOMENT.',
  );
  $('#video-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;
    const form = e.currentTarget,
      values = new FormData(form),
      file = values.get('file');
    if (
      !['video/mp4', 'video/webm'].includes(file.type) ||
      file.size > 20_000_000 ||
      file.size <= 12
    ) {
      formError(form, 'Choose a playable MP4 or WebM video under 20 MB.');
      return;
    }
    setSaving(true);
    form.querySelector('.form-error').hidden = true;
    $('#video-progress').hidden = false;
    const status = $('#video-status'),
      progress = $('#video-progress progress');
    try {
      status.textContent = 'Checking video…';
      progress.value = 0;
      const bytes = await file.arrayBuffer(),
        hash = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
          (b) => b.toString(16).padStart(2, '0'),
        ).join('');
      const upload = await api('video-start', {
        title: values.get('title'),
        playerId: values.get('playerId'),
        size: file.size,
        mime: file.type,
        hash,
      });
      for (let i = 0; i < upload.chunks; i++) {
        const chunk = bytes.slice(
          i * upload.chunkBytes,
          Math.min(bytes.byteLength, (i + 1) * upload.chunkBytes),
        );
        const send = () =>
          api('chunk', chunk, {
            method: 'PUT',
            params: { id: upload.id, index: i },
          });
        try {
          await send();
        } catch (error) {
          if (error.status && error.status < 500) throw error;
          await send();
        }
        progress.value = Math.round(((i + 1) / upload.chunks) * 95);
        status.textContent = `Uploading… ${progress.value}%`;
      }
      status.textContent = 'Verifying the complete video…';
      await api('video-finish', { id: upload.id });
      progress.value = 100;
      await refresh();
      setSaving(false);
      closeModal();
      toast('Gameplay posted. Let the lobby react.');
    } catch (error) {
      setSaving(false);
      status.textContent = 'Upload did not finish.';
      formError(form, error.message);
    }
  });
}

document.addEventListener('click', async (e) => {
  const button = e.target.closest('[data-action]');
  if (!button) return;
  if (!state) {
    toast('Wait for the league to connect, then try again.', true);
    return;
  }
  if (saving) return;
  const action = button.dataset.action;
  if (action === 'upload') uploadModal(button.dataset.pair);
  else if (action === 'resume') void resumeDraft();
  else if (action === 'player-detail') playerDetailModal(button.dataset.player);
  else if (action === 'filters') filtersModal();
  else if (action === 'match-detail') matchDetailModal(button.dataset.pair);
  else if (action === 'receipt') {
    const m = state.matches.find(
      (m) => m.id === button.dataset.pair && m.status === 'completed',
    );
    if (m)
      savedResultModal(
        m,
        { savedAt: m.completedAt, receiptId: m.receiptId },
        true,
      );
  } else if (action === 'schedule') scheduleModal();
  else if (action === 'player') playerModal();
  else if (action === 'reminder') reminderModal(button.dataset.player);
  else if (action === 'evidence') evidenceModal(button.dataset.pair);
  else if (action === 'video') videoModal();
  else if (action === 'react') {
    const clip = state.clips.find((c) => c.id === button.dataset.clip);
    if (!clip) return;
    button.disabled = true;
    try {
      await api('react', {
        clipId: clip.id,
        reaction:
          clip.myReaction === button.dataset.reaction
            ? null
            : button.dataset.reaction,
      });
      await refresh();
      feedback('selection');
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  }
});
$('#modal-close').addEventListener('click', closeModal);
modal.addEventListener('close', () => {
  activeCharterMatchId = null;
  modalVersion++;
  releasePreview();
});
window.addEventListener('hashchange', () => {
  if (!saving) {
    closeModal();
    void hideSheet($('#settings-sheet'));
  }
});
modal.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeModal();
});
modal.addEventListener('click', (e) => {
  if (e.target === modal) {
    const rect = modal.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    )
      closeModal();
  }
});
function renderSettingsPin() {
  const panel = $('#settings-pin-panel');
  if (!panel || !state) return;
  const badge = $('#settings-pin-player-badge');
  const display = $('#settings-pin-display');
  const copyBtn = $('#btn-settings-copy-pin');
  const newPinBtn = $('#btn-settings-new-pin');
  const myPlayerId = state.myPlayerId;
  const myPlayer = state.players?.find((p) => p.isMyPlayer || p.id === myPlayerId);

  let activePin = myPlayer?.myPin || '';
  if (!activePin && myPlayerId) {
    try {
      activePin = localStorage.getItem('player-pin-' + myPlayerId) || '';
    } catch {}
  }

  if (myPlayer) {
    badge.textContent = myPlayer.name;
    badge.style.color = '#f3b218';
    badge.style.borderColor = 'rgba(243,178,24,0.4)';
    if (activePin) {
      display.textContent = activePin;
      display.style.letterSpacing = '8px';
      display.style.color = '#4caf50';
      if (copyBtn) copyBtn.disabled = false;
      if (newPinBtn) newPinBtn.disabled = false;
    } else {
      display.textContent = 'NO ACTIVE PIN';
      display.style.letterSpacing = '2px';
      display.style.fontSize = '18px';
      display.style.color = '#aaa';
      if (copyBtn) copyBtn.disabled = true;
      if (newPinBtn) newPinBtn.disabled = false;
    }
  } else {
    badge.textContent = 'NO PLAYER BOUND';
    badge.style.color = '#888';
    display.textContent = 'CLAIM IN STANDINGS';
    display.style.letterSpacing = '1px';
    display.style.fontSize = '16px';
    display.style.color = '#888';
    if (copyBtn) copyBtn.disabled = true;
    if (newPinBtn) newPinBtn.disabled = true;
  }
}

$('#btn-settings-copy-pin')?.addEventListener('click', async () => {
  const display = $('#settings-pin-display');
  const pin = display?.textContent?.trim();
  if (pin && /^\d{6}$/.test(pin)) {
    try {
      await navigator.clipboard.writeText(pin);
      toast('PIN ' + pin + ' copied to clipboard!');
      feedback('saved');
    } catch {
      toast('Could not copy automatically. PIN is ' + pin);
    }
  }
});

$('#btn-settings-new-pin')?.addEventListener('click', async () => {
  if (saving) return;
  const myPlayerId = state?.myPlayerId;
  if (!myPlayerId) {
    toast('Tap your player name in Standings to claim your PIN first.', true);
    return;
  }
  const btn = $('#btn-settings-new-pin');
  btn.disabled = true;
  try {
    const res = await api('reveal-pin', { playerId: myPlayerId, forceReset: true });
    if (res.pin) {
      try {
        localStorage.setItem('player-pin-' + myPlayerId, res.pin);
      } catch {}
      await refresh(false, true);
      toast('New PIN generated: ' + res.pin);
      feedback('saved');
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('#refresh').addEventListener('click', () => void refresh(true));
$('#btn-reset-all-pins')?.addEventListener('click', async () => {
  if (saving) return;
  const btn = $('#btn-reset-all-pins');
  btn.disabled = true;
  btn.textContent = 'Clearing PINs…';
  try {
    const res = await api('reset-all-pins', {});
    // Clear all player-pin-* and device preferences in localStorage
    try {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('player-pin-') || k === 'my-player-id')) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch {}
    await refresh(false, true);
    btn.textContent = 'Reset PINs & Claims (Standings Safe)';
    btn.disabled = false;
    void hideSheet($('#settings-sheet'));
    toast(res.message || 'All PINs and device locks have been cleared. Standings preserved.');
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Reset PINs & Claims (Standings Safe)';
    toast(err.message, true);
  }
});
document.querySelectorAll('[data-filter]').forEach((button) =>
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    showAll = false;
    document.querySelectorAll('[data-filter]').forEach((b) => {
      b.classList.toggle('active', b === button);
      b.setAttribute('aria-pressed', String(b === button));
    });
    renderMatches();
  }),
);
$('#player-filter').addEventListener('change', () => {
  showAll = false;
  renderMatches();
});
$('#show-more').addEventListener('click', () => {
  showAll = !showAll;
  renderMatches();
});
$('#menu-toggle').addEventListener('click', () => {
  const menu = $('#mobile-nav');
  menu.hidden = !menu.hidden;
  $('#menu-toggle').setAttribute('aria-expanded', String(!menu.hidden));
});
$('#mobile-nav').addEventListener('click', (e) => {
  if (e.target.closest('a')) {
    $('#mobile-nav').hidden = true;
    $('#menu-toggle').setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
  else document.querySelectorAll('.clip-card video').forEach((v) => v.pause());
});
window.addEventListener('online', () => void refresh());
window.addEventListener('offline', () => {
  connection('offline');
  $('#connection-status').innerHTML =
    '<span class="status-dot offline"></span> Offline · saved results are safe';
  $('#standings-sync').innerHTML =
    '<span class="status-dot offline"></span> SYNC PAUSED';
  $('#connection-error').textContent =
    'You are offline. Posted results remain saved. Reconnect to upload or get the latest standings.';
  $('#connection-error').hidden = false;
});
window.addEventListener('pageshow', () => {
  if (state) void refresh();
});
window.addEventListener('beforeunload', (event) => {
  if (saving || (draft && !draftDurable)) {
    event.preventDefault();
    event.returnValue = '';
  }
});
document.addEventListener(
  'play',
  (e) => {
    if (e.target instanceof HTMLVideoElement)
      document.querySelectorAll('video').forEach((v) => {
        if (v !== e.target) v.pause();
      });
  },
  true,
);
hydrateIcons();
setupFeedback();
render();
setupPhone();
void readDraft().then((value) => {
  if (!draft && value?.file) {
    draft = value;
    draftDurable = true;
    showDraft();
  }
});
if (import.meta.env.PROD && 'serviceWorker' in navigator)
  void navigator.serviceWorker.register('/sw.js').catch(() => {});
setupMotion();
setupBattleSequence();
setupBattleAudio();
setupLobby();
setupSoundtrack();
void refresh();
function scheduleNextPoll() {
  const delay = activeCharterMatchId && modal.open ? 1500 : 5000;
  setTimeout(() => {
    if (!document.hidden && !saving) {
      void refresh().finally(scheduleNextPoll);
    } else {
      scheduleNextPoll();
    }
  }, delay);
}
scheduleNextPoll();
