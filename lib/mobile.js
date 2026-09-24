import {
  fixtures,
  leagueSummary,
  standings,
  remainingOpponents,
} from './league.js';
import { icon } from './icons.js';

let followed = '';
try {
  followed = localStorage.getItem('solo-followed-player') || '';
} catch {
  /* Preference only. */
}
let latest, helpers;

export function renderPhone(state, renderHelpers) {
  latest = state;
  helpers = renderHelpers;
  const { escape, avatar, names } = helpers;
  if (!state.players.some((p) => p.id === followed)) followed = '';
  const rows = standings(state);
  const focused = document.activeElement?.closest(
    '[data-action="player-detail"]',
  )?.dataset.player;
  document.querySelector('#phone-standings').innerHTML = rows
    .map(
      (p) =>
        `<button class="rank-card rank-button ${p.rank === 1 ? 'rank-leading' : ''}" data-action="player-detail" data-player="${escape(p.id)}" aria-label="${escape(p.name)}, ${p.points} points. Open player details"><span class="rank-place">${p.rank ?? '—'}</span>${avatar(p.id)}<span class="rank-identity"><strong>${escape(p.name)}</strong><span>${p.played ? `${p.wins}W · ${p.losses}L · ${p.diff > 0 ? '+' : ''}${p.diff} diff` : 'Yet to play'}</span></span><span class="rank-points">${p.points}<small>PTS</small></span><span class="rank-chevron" aria-hidden="true">›</span></button>`,
    )
    .join('');
  if (focused)
    [...document.querySelectorAll('#phone-standings button')]
      .find((b) => b.dataset.player === focused)
      ?.focus({ preventScroll: true });
  const leaders = rows.filter((p) => p.played).slice(0, 3);
  document.querySelector('#home-leaders').innerHTML =
    `<div class="preview-heading"><span class="eyebrow">THE LEAGUE, RIGHT NOW</span><a class="text-link" href="#league">All ranks ${icon('arrow-up-right')}</a></div>${leaders.length ? leaders.map((p) => `<button class="mini-rank" data-action="player-detail" data-player="${escape(p.id)}"><span class="rank-place">${p.rank}</span>${avatar(p.id)}<strong>${escape(p.name)}</strong><span>${p.points}<small>PTS</small></span></button>`).join('') : '<div class="standings-empty">' + icon('trophy') + '<div><strong>No ranks before results.</strong><p>The first posted match starts the table.</p></div></div>'}`;
  renderHub();
}

function renderHub() {
  const restoreFocus = document.activeElement?.id === 'follow-player';
  const state = latest,
    { escape, avatar, names } = helpers,
    summary = leagueSummary(state);
  const all = fixtures(state).filter((m) => m.status !== 'completed');
  const halfAgreed = all.find((m) => (m.acceptedA && !m.acceptedB) || (!m.acceptedA && m.acceptedB));
  const next =
    (followed && all.find((m) => (m.acceptedA || m.acceptedB) && [m.playerA, m.playerB].includes(followed))) ||
    halfAgreed ||
    all.find((m) => followed && [m.playerA, m.playerB].includes(followed)) ||
    (!followed && (all.find((m) => m.status === 'queued') || all[0]));
  const remaining = followed
    ? remainingOpponents(state, followed).length
    : summary.remaining;
  document.querySelector('#mobile-hub').innerHTML =
    `<div class="hub-title"><span class="eyebrow">THE NEXT MOVE</span><label class="follow-picker"><span class="sr-only">Follow a player; this is a view preference, not sign-in</span><select id="follow-player"><option value="">Whole league</option>${state.players.map((p) => `<option value="${escape(p.id)}" ${followed === p.id ? 'selected' : ''}>${escape(p.name)}</option>`).join('')}</select></label></div>
    <article class="hub-match"><div class="hub-match-top"><span>${next ? (next.status === 'queued' ? 'Ready to play' : 'Still to play') : 'All played'}</span><span>${remaining} ${followed ? 'opponents' : 'matches'} left</span></div>${next ? `<div class="hub-versus"><div>${avatar(next.playerA)}<strong>${escape(names(next.playerA))}</strong></div><span>vs</span><div>${avatar(next.playerB)}<strong>${escape(names(next.playerB))}</strong></div></div><button class="button button-dark" data-action="upload" data-pair="${escape(next.id)}">Post this match ${icon('arrow-up-right')}</button>` : `<h3>${summary.disputes ? 'Results under review.' : 'Your results are in.'}</h3><p>Every result stays on the matchboard.</p><a class="button button-dark" href="#league">View the standings ${icon('arrow-up-right')}</a>`}</article>
    <div class="hub-foot"><span>${summary.unplayed.length ? `${summary.unplayed.length} player${summary.unplayed.length === 1 ? '' : 's'} yet to post` : 'Everyone has posted a result'}</span><button class="text-link" data-action="reminder" data-player="${escape(followed)}">Remind ${icon('copy')}</button></div>`;
  document.querySelector('#follow-player').addEventListener('change', (e) => {
    followed = e.target.value;
    try {
      localStorage.setItem('solo-followed-player', followed);
    } catch {
      /* Optional. */
    }
    renderHub();
    document.querySelector('#follow-player').focus({ preventScroll: true });
  });
  if (restoreFocus)
    document.querySelector('#follow-player').focus({ preventScroll: true });
}

export function setupPhone() {
  const tabs = [...document.querySelectorAll('.phone-tabs [data-tab]')];
  let waiting = false;
  function updateTabs() {
    waiting = false;
    const y = scrollY + innerHeight * 0.35;
    let active = 'home';
    for (const section of document.querySelectorAll(
      '#home, #league, #matches, #players, #cinematic, #clips',
    )) {
      if (section.offsetTop <= y) active = section.id;
    }
    if (active === 'players') active = 'matches';
    if (active === 'cinematic') active = 'clips';
    tabs.forEach((tab) => {
      if (tab.dataset.tab === active) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    });
  }
  window.addEventListener(
    'scroll',
    () => {
      if (!waiting) {
        waiting = true;
        requestAnimationFrame(updateTabs);
      }
    },
    { passive: true },
  );
  window.addEventListener('resize', updateTabs, { passive: true });
  function route() {
    const aliases = {
      overview: 'home',
      standings: 'league',
      matchboard: 'matches',
      highlights: 'clips',
    };
    const name = location.hash.slice(1),
      id = aliases[name] || name || 'home';
    if (aliases[name] || !name)
      history.replaceState(history.state, '', '#' + id);
    const target = document.getElementById(id);
    if (id === 'cinematic' && target?.classList.contains('is-immersive'))
      window.scrollTo({ top: target.offsetTop, behavior: 'instant' });
    else if (['home', 'league', 'matches', 'clips', 'cinematic'].includes(id))
      target?.scrollIntoView({ block: 'start' });
    updateTabs();
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('load', route, { once: true });
  updateTabs();
  const viewport = window.visualViewport;
  function keyboard() {
    document.documentElement.classList.toggle(
      'keyboard-open',
      !!viewport &&
        innerHeight - viewport.height > 150 &&
        /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName),
    );
  }
  viewport?.addEventListener('resize', keyboard);
  document.addEventListener('focusout', () =>
    document.documentElement.classList.remove('keyboard-open'),
  );
}
