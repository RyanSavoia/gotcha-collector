'use strict';
// One daily USD budget, shared by every LLM caller: the 5-minute harvest ticks and
// the gauntlet's examiner runs alike.
//
// The point is that a tick which cannot afford extraction must DEFER rather than
// skip -- it leaves the watermark where it is, so the content is picked up after the
// daily reset instead of being silently dropped. Cheap-but-lossy is the failure mode
// worth engineering against here.

const state = require('./state');

function todayKey() { return new Date().toISOString().slice(0, 10); }

function read(st) {
  const b = st.budget || {};
  if (b.date !== todayKey()) return { date: todayKey(), spentUsd: 0, calls: 0 };
  return { date: b.date, spentUsd: b.spentUsd || 0, calls: b.calls || 0 };
}

/** Remaining USD today, given a cap. */
function remaining(cap) {
  const st = state.read();
  const b = read(st);
  return Math.max(0, cap - b.spentUsd);
}

function status(cap) {
  const b = read(state.read());
  return { date: b.date, spentUsd: b.spentUsd, calls: b.calls, cap, remaining: Math.max(0, cap - b.spentUsd) };
}

/** Record a charge. Rolls over automatically on a new day. */
function charge(usd, calls) {
  const st = state.read();
  const b = read(st);
  b.spentUsd = Math.round((b.spentUsd + (usd || 0)) * 1e6) / 1e6;
  b.calls += (calls || 1);
  st.budget = b;
  state.write(st);
  return b;
}

/** Can we afford at least one more call of roughly this size? */
function canSpend(cap, estimateUsd) {
  return remaining(cap) >= (estimateUsd || 0);
}

module.exports = { read, remaining, charge, canSpend, status, todayKey };
