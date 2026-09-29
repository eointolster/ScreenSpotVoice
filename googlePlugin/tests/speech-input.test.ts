import { test } from 'node:test';
import assert from 'node:assert/strict';

type Handler = ((event: any) => void) | null;
const sessions: any[] = [];
(globalThis as any).SpeechRecognition = class {
  lang = ''; continuous = false; interimResults = false; maxAlternatives = 0;
  onresult: Handler = null; onerror: Handler = null; onend: Handler = null;
  started = 0; aborted = 0;
  start() { this.started += 1; sessions.push(this); }
  stop() { /* not used by the module under test */ }
  abort() { this.aborted += 1; }
};

const input = await import('../src/speech-input');

function fireFinal(session: any, text: string) {
  session.onresult?.({
    resultIndex: 0,
    results: Object.assign([{ 0: { transcript: text }, length: 1, isFinal: true }], { length: 1 }),
  });
}

function newest() {
  return sessions[sessions.length - 1];
}

test('an utterance matching the assistant reply is treated as echo', () => {
  const finals: string[] = [];
  input.setListener({ onFinal: t => finals.push(t), onInterim: () => {}, onState: () => {} });
  input.startListening();
  const session = newest();

  // A genuine question first, then the assistant answers, then the mic hears it.
  fireFinal(session, 'where is the upload button');
  assert.deepEqual(finals, ['where is the upload button']);

  input.noteAssistantSaid('The upload button is the blue one, top left.');
  assert.equal(input.looksLikeEcho('The upload button is the blue one top left'), true);
  assert.equal(input.looksLikeEcho('put a box around the search field'), false);
});

test('recognising stops while the assistant speaks and resumes after', async () => {
  input.setListener({ onFinal: () => {}, onInterim: () => {}, onState: () => {} });
  input.startListening();
  const listening = newest();
  assert.equal(listening.started, 1);

  input.setAssistantBusy(true);
  assert.ok(listening.aborted >= 1, 'the active session must be aborted while speaking');

  input.setAssistantBusy(false);
  await new Promise(r => setTimeout(r, 700));   // longer than the settle window
  assert.ok(newest().started >= 1, 'a new session must start once playback ends');
  input.stopListening();
});

test('nothing is captured during the settle window after playback', () => {
  const finals: string[] = [];
  input.setListener({ onFinal: t => finals.push(t), onInterim: () => {}, onState: () => {} });
  input.stopListening();
  input.startListening();
  input.noteAssistantSaid('I could not answer that.');
  input.setAssistantBusy(true);
  input.setAssistantBusy(false);

  // The room is still ringing: anything heard now is discarded, not asked.
  fireFinal(newest(), 'i could not answer that');
  assert.deepEqual(finals, [], 'echo during the settle window must not be forwarded');
  input.stopListening();
});

test('a repeated echo loop is reported instead of looping forever', () => {
  let loops = 0;
  input.setListener({ onFinal: () => {}, onInterim: () => {}, onState: () => {} });
  input.onEchoLoopDetected(() => { loops += 1; });
  input.stopListening();
  input.startListening();
  input.noteAssistantSaid('I can help you locate anything visible on this page.');

  for (let i = 0; i < 4; i += 1) fireFinal(newest(), 'i can help you locate anything visible on this page');
  assert.equal(loops, 1, 'the guard must escalate rather than loop indefinitely');
  input.onEchoLoopDetected(null);
  input.stopListening();
});

test('stopping clears echo state so the next question is heard', () => {
  input.setListener({ onFinal: () => {}, onInterim: () => {}, onState: () => {} });
  input.startListening();
  input.noteAssistantSaid('Here it is.');
  assert.equal(input.looksLikeEcho('here it is'), true);
  input.stopListening();
  input.startListening();
  assert.equal(input.looksLikeEcho('here it is'), false, 'a stopped session must forget the reply');
  input.stopListening();
});