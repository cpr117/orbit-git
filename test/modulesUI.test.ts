import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';

type Input = { key?: string; preventDefault(): void };
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  style = { setProperty() {} };
  classList = {
    contains: (name: string) => this.className.split(' ').includes(name),
    toggle: (name: string, force?: boolean) => {
      const next = force ?? !this.classList.contains(name);
      this.className = this.className.split(' ').filter(value => value && value !== name).concat(next ? [name] : []).join(' ');
      return next;
    },
    add: (name: string) => { this.classList.toggle(name, true); },
    remove: (name: string) => { this.classList.toggle(name, false); },
  };
  attrs = new Map<string, string>();
  value = ''; textContent = ''; className = ''; innerHTML = ''; disabled = false; hidden = false;
  scrollTop = 0; tabIndex = 0;
  onclick?: () => void;
  oninput?: () => void;
  onchange?: () => void;
  onsubmit?: (event: Input) => void;
  onkeydown?: (event: Input) => void;
  oncontextmenu?: (event: Input) => void;
  title = "";
  constructor(private readonly document: { activeElement?: Element }) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  contains(element?: Element): boolean { return this === element || this.children.some(child => child.contains(element)); }
  focus() { this.document.activeElement = this; }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  getAttribute(key: string) { return this.attrs.get(key); }
  addEventListener(type: string, listener: () => void) { if (type === 'click') this.onclick = listener; }
  querySelector() { return undefined; }
}
function fixture(enabled: Record<string, boolean> = {}, savedTab = 'history') {
  const root = path.resolve(__dirname, '../..');
  const elements = new Map<string, Element>();
  const document = {
    activeElement: undefined as Element | undefined,
    documentElement: { lang: '' },
    getElementById(id: string) { if (!elements.has(id)) elements.set(id, new Element(document)); return elements.get(id)!; },
    createElement() { return new Element(document); },
    querySelector(selector: string) { return document.getElementById(selector); },
    addEventListener() {},
  };
  const messages: { type: string; path?: string; filters?: Record<string, unknown> }[] = [];
  let listener: (event: unknown) => void;
  const window = { gitWorkbenchLanguage: 'en', gitWorkbenchModules: enabled, addEventListener(_type: string, callback: typeof listener) { listener = callback; } };
  const api = { getState: () => ({ tab: savedTab }), setState() {}, postMessage: (message: { type: string }) => messages.push(message) };
  runInNewContext(readFileSync(path.join(root, 'media/workbench.js'), 'utf8'), {
    window, document, acquireVsCodeApi: () => api,
    GitSelection: require(path.join(root, 'media/selection.js')),
    GitComparisonTree: require(path.join(root, 'media/comparisonTree.js')),
    GitLogModel: require(path.join(root, 'media/logModel.js')),
    GitWorkbenchI18n: require(path.join(root, 'media/i18n.js')),
  });
  return { element: document.getElementById, messages, receive: (type: string, data: unknown) => listener({ data: { type, data } }) };
}

test('disabled tab cannot be restored from saved state or reached by keyboard or stale click', () => {
  const { element } = fixture({ graph: false }, 'history');
  assert.equal(element('history-tab').hidden, true); assert.equal(element('history-view').hidden, true);
  assert.equal(element('stash-view').hidden, false); assert.equal(element('stash-tab').tabIndex, 0);
  element('history-tab').onclick!(); assert.equal(element('history-view').hidden, true);
  for (const key of ['Home', 'End', 'ArrowLeft', 'ArrowRight']) element('.tabs').onkeydown!({ key, preventDefault() {} });
  assert.equal(element('history-view').hidden, true); assert.equal(element('stash-view').hidden, false);
});

test('live module changes update write controls and tab fallback, with an always available settings button', () => {
  const { element, receive, messages } = fixture();
  receive('modules', { operations: false, stash: false });
  for (const id of ['operations', 'new-branch', 'stash-create', 'continue', 'abort', 'stash-tab']) assert.equal(element(id).hidden, true, id);
  assert.equal(element('history-view').hidden, false);
  receive('operating', false); assert.equal(element('stash-create').hidden, true);
  receive('modules', { graph: false });
  assert.equal(element('history-view').hidden, true); assert.equal(element('stash-view').hidden, true); assert.equal(element('modules-empty').hidden, false);
  element('modules').onclick!(); assert.equal(messages.at(-1)!.type, 'modules');
  receive('modules', { stash: true, operations: true });
  assert.equal(element('stash-view').hidden, false); assert.equal(element('operations').hidden, false); assert.equal(element('modules-empty').hidden, true);
});

test('turning off writes removes restore and commit actions from an already displayed commit', () => {
  const { element, receive } = fixture();
  receive('detail', { commit: { subject: 'Fixture', author: 'Test', date: '', parents: [] }, message: 'Fixture', target: 'a'.repeat(40), files: [{ path: 'a.txt', status: 'M' }] });
  assert.equal(element('changed-files').children[1].children.length, 2);
  receive('modules', { operations: false });
  assert.equal(element('changed-files').children[1].children.length, 1, 'native diff remains, restore is removed');
  const body = element('commit-detail').children[1];
  assert.equal(body.children.find(node => node.className === 'detail-toolbar')!.children.length, 0);
});


test('branch menus retain read-only comparisons and do not show empty menus or leftover separators', () => {
  const { element, receive } = fixture();
  receive('snapshot', { root: '/fixture', refs: [{ full: 'refs/heads/other', name: 'other', current: false, tag: false, remote: false }], commits: [], graph: [], filters: {}, state: { branch: 'main' }, stashes: [] });
  const find = (node: Element): Element | undefined => node.title === 'refs/heads/other' ? node : node.children.map(find).find(Boolean);
  const row = find(element('refs'))!;
  receive('modules', { operations: false });
  row.oncontextmenu!({ preventDefault() {} });
  const menu = element('context-menu');
  assert.equal(menu.hidden, false);
  assert.equal(menu.children.length, 2);
  assert.ok(menu.children.every(child => child.textContent.includes('Compare') || child.textContent.includes('Diff')));
  receive('modules', { comparison: false });
  row.oncontextmenu!({ preventDefault() {} });
  assert.equal(menu.children.length, 0); assert.equal(menu.hidden, true);
});

test('clicked log file stays selected through a redraw and switches or clears with the detail context', () => {
  const { element, receive, messages } = fixture();
  const detail = { compare: true, base: 'a'.repeat(40), target: 'b'.repeat(40), message: 'Comparison', files: [{ path: 'src/a.txt', status: 'M' }, { path: 'src/b.txt', status: 'A' }] };
  receive('detail', detail);
  const rows = () => element('changed-files').children.slice(1);
  rows()[0].children[0].onclick!();
  assert.equal(messages.at(-1)!.type, 'diff'); assert.equal(messages.at(-1)!.path, 'src/a.txt');
  element('commits').focus();
  assert.equal(rows()[0].classList.contains('selected'), true, 'selection remains after focus leaves the file');
  assert.equal(rows()[0].children[0].getAttribute('aria-pressed'), 'true');
  rows()[1].children[0].onclick!();
  assert.deepEqual(rows().map(row => row.classList.contains('selected')), [false, true]);
  receive('detail', detail);
  assert.deepEqual(rows().map(row => row.classList.contains('selected')), [false, true], 'refresh retains selection');
  receive('modules', { operations: false });
  assert.equal(rows()[1].classList.contains('selected'), true, 'module changes redraw without losing selection');
  receive('detail', { ...detail, base: 'c'.repeat(40) });
  assert.ok(rows().every(row => !row.classList.contains('selected')), 'a different parent or comparison clears selection');
  receive('detail', detail);
  rows()[0].children[0].onclick!();
  receive('detail', { ...detail, files: [detail.files[1]] });
  assert.equal(rows()[0].classList.contains('selected'), false, 'removed files cannot remain selected');
  rows()[0].children[0].onclick!(); receive('reset', null); receive('detail', detail);
  assert.ok(rows().every(row => !row.classList.contains('selected')), 'repository reset clears selection');
});

test('author dropdown uses all repository authors, preserves other filters and supports manual expressions', () => {
  const { element, receive, messages } = fixture();
  const snapshot = { root: '/fixture', refs: [], commits: [], graph: [], filters: { search: 'fix [case]', path: 'src', since: '2026-01-01' }, authors: ['A.[bot]*', 'Other'], state: { branch: 'main' }, stashes: [] };
  receive('snapshot', snapshot);
  assert.deepEqual(element('author-select').children.map(option => option.textContent), ['All authors', 'A.[bot]*', 'Other']);
  const pattern = element('author-select').children[1].value;
  element('author-select').value = pattern; element('author-select').onchange!();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1)!.filters)), { ...snapshot.filters, author: '^A\\.\\[bot]\\* <', until: '', limit: 200 });
  receive('snapshot', { ...snapshot, filters: messages.at(-1)!.filters });
  assert.equal(element('author-select').value, pattern);
  assert.equal(element('author-select').children.length, 3, 'filtering does not shrink the author list');
  element('author').value = 'A.*'; element('author').oninput!();
  assert.equal(element('author-select').children.at(-1)!.textContent, 'Custom author filter');
  assert.equal(element('author-select').value, 'A.*');
  element('author-select').value = ''; element('author-select').onchange!();
  assert.equal(messages.at(-1)!.filters!.author, ''); assert.equal(messages.at(-1)!.filters!.search, 'fix [case]');
  receive('reset', null);
  assert.deepEqual(element('author-select').children.map(option => option.textContent), ['All authors']);
});
