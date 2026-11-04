/*
 * The response screen: status, then the body, headers, what was actually sent
 * (timeline) and test results, with search and a JSONPath filter for the body.
 */
'use no memo'; // React Compiler mis-memoizes optional chains here (env?.variables read as env.variables).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import get from 'lodash/get';
import CodeEditor from 'components/CodeEditor';
import QueryResultPreview from 'components/ResponsePane/QueryResult/QueryResultPreview';
import { useInitialResponseFormat } from 'components/ResponsePane/QueryResult';
import { useTheme } from 'providers/Theme';
import { formatResponse, formatSize } from 'utils/common';
import { detectContentTypeFromBase64 } from 'utils/response';
import { Header, IconButton, Icon, MethodLabel, Tabs, Empty } from './ui';
import { statusTone } from './list';

const MODES = { json: 'application/ld+json', html: 'xml', xml: 'xml', javascript: 'javascript' };
const LARGE = 10 * 1024 * 1024;

export const bodyText = (response, format, filter) => {
  try {
    return formatResponse(response.data, response.dataBuffer, format, filter);
  } catch (e) {
    return typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2);
  }
};

const headerEntries = (headers) => Object.entries(headers || {}).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value)]);

export const testSummary = (item) => {
  const all = [
    ...(item.preRequestTestResults || []),
    ...(item.testResults || []),
    ...(item.postResponseTestResults || []),
    ...(item.assertionResults || [])
  ];
  return { total: all.length, passed: all.filter((r) => r.status === 'pass').length };
};

const timeOf = (item) => {
  const ts = item.requestSent?.timestamp;
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (e) {
    return '';
  }
};

const useCodeFont = () => {
  const preferences = useSelector((state) => state.app.preferences);
  return { font: get(preferences, 'font.codeFont', 'default'), fontSize: get(preferences, 'font.codeFontSize') };
};

// Marks every match of `query` in a CodeMirror editor and scrolls to the
// current one. Returns the number of matches.
const markMatches = (editor, query, current, marks) => {
  marks.current.forEach((m) => m.clear());
  marks.current = [];
  if (!editor || !query) return 0;
  const text = editor.getValue().toLowerCase();
  const needle = query.toLowerCase();
  const found = [];
  for (let at = text.indexOf(needle); at !== -1 && found.length < 1000; at = text.indexOf(needle, at + needle.length)) found.push(at);
  found.forEach((at, i) => {
    const from = editor.posFromIndex(at);
    const to = editor.posFromIndex(at + needle.length);
    marks.current.push(editor.markText(from, to, { className: i === current ? 'bw-hit bw-hit-current' : 'bw-hit' }));
    if (i === current) editor.scrollIntoView({ from, to }, 80);
  });
  return found.length;
};

const BodyView = ({ item, collection, find, filter }) => {
  const response = item.response;
  const { displayedTheme } = useTheme();
  const { font, fontSize } = useCodeFont();
  const { initialFormat, initialTab } = useInitialResponseFormat(response.dataBuffer, response.headers);
  const format = initialFormat || 'raw';
  const [view, setView] = useState(null);
  const tab = view || (initialTab === 'preview' && format !== 'json' ? 'preview' : 'editor');
  const [reveal, setReveal] = useState(false);
  const large = (response.size || 0) > LARGE && !reveal;
  const text = useMemo(() => (large ? '' : bodyText(response, format, format === 'json' ? filter : undefined)), [response, format, filter, large]);
  const editorRef = useRef(null);
  const marks = useRef([]);

  useEffect(() => {
    const editor = editorRef.current?.editor;
    const n = markMatches(editor, find?.query, find?.current ?? 0, marks);
    find?.onCount?.(n);
  }, [text, find?.query, find?.current]);

  if (large) {
    return (
      <Empty>
        This response is {formatSize(response.size)}. Showing it may slow the page down.
        <button type="button" className="bw-link" onClick={() => setReveal(true)}>Show anyway</button>
      </Empty>
    );
  }

  const detected = detectContentTypeFromBase64(response.dataBuffer);
  const previewMode = format === 'html' || format === 'javascript' ? 'preview-web'
    : detected && detected.includes('image') ? 'preview-image'
      : detected && detected.includes('pdf') ? 'preview-pdf'
        : detected && detected.includes('audio') ? 'preview-audio'
          : detected && detected.includes('video') ? 'preview-video' : 'preview-text';
  const canPreview = previewMode !== 'preview-text';

  return (
    <div className="bw-body-view">
      {canPreview ? (
        <div className="bw-seg bw-seg-small" role="group" aria-label="Body view">
          <button type="button" aria-pressed={tab === 'preview'} onClick={() => setView('preview')}>Preview</button>
          <button type="button" aria-pressed={tab === 'editor'} onClick={() => setView('editor')}>Source</button>
        </div>
      ) : null}
      {tab === 'preview' && canPreview ? (
        <div className="bw-preview">
          <QueryResultPreview
            selectedTab="preview"
            data={response.data}
            dataBuffer={response.dataBuffer}
            formattedData={text}
            item={item}
            contentType={detected}
            previewMode={previewMode}
            codeMirrorMode={MODES[format] || 'text/plain'}
            collection={collection}
            displayedTheme={displayedTheme}
            docKey={`bw-phone:${item.uid}:response-preview`}
          />
        </div>
      ) : (
        <div className="bw-code bw-code-fill" data-testid="bw-phone-response-body">
          <CodeEditor
            ref={editorRef}
            value={text}
            mode={MODES[format] || 'text/plain'}
            readOnly
            theme={displayedTheme}
            font={font}
            fontSize={fontSize}
            collection={collection}
            item={item}
            enableLineWrapping
            enableBrunoVarInfo={false}
            docKey={`bw-phone:${item.uid}:response`}
          />
        </div>
      )}
    </div>
  );
};

const HeadersView = ({ headers }) => {
  const rows = headerEntries(headers);
  if (!rows.length) return <Empty>No headers.</Empty>;
  return (
    <div className="bw-scroll">
      {rows.map(([name, value]) => (
        <div className="bw-kv-stack" key={name}>
          <div className="bw-kv-name">{name}</div>
          <div className="bw-kv-value bw-mono">{value}</div>
        </div>
      ))}
    </div>
  );
};

const TimelineView = ({ item, onCopyCurl, onTab }) => {
  const [logsOpen, setLogsOpen] = useState(false);
  const sent = item.requestSent || {};
  const response = item.response || {};
  const headers = headerEntries(sent.headers);
  const body = sent.data == null ? '' : typeof sent.data === 'string' ? sent.data : JSON.stringify(sent.data);
  const logs = Array.isArray(response.timeline) ? response.timeline : [];
  return (
    <div className="bw-scroll bw-pad">
      <div className="bw-between">
        <h2 className="bw-h">Request</h2>
        <button type="button" className="bw-link" onClick={onCopyCurl} data-testid="bw-phone-copy-curl">Copy as cURL</button>
      </div>
      {sent.url ? (
        <div className="bw-mono bw-wrap" data-testid="bw-phone-sent-url"><MethodLabel method={sent.method || ''} /> {sent.url}</div>
      ) : <Empty>Nothing was sent.</Empty>}
      {headers.length ? (
        <>
          <h3 className="bw-label">Headers</h3>
          <div className="bw-box bw-mono bw-wrap">
            {headers.map(([n, v]) => <div key={n}><span className="bw-key">{n}</span>: {v}</div>)}
          </div>
        </>
      ) : null}
      {body ? (
        <>
          <h3 className="bw-label">Body</h3>
          <div className="bw-box bw-mono bw-wrap">{body}</div>
        </>
      ) : null}
      <div className="bw-between bw-gap-top">
        <h2 className="bw-h">Response</h2>
      </div>
      <div className="bw-status-inline">
        {response.status ? <span className={`bw-${statusTone(response.status)}`}>{response.status} {response.statusText}</span> : <span className="bw-danger">{response.error ? 'Error' : 'No response'}</span>}
        {response.duration != null ? <span className="bw-muted">{response.duration} ms</span> : null}
      </div>
      <button type="button" className="bw-row bw-plain" onClick={() => onTab('headers')}>
        <span className="bw-name">Headers <span className="bw-muted">{headerEntries(response.headers).length}</span></span>
        <Icon name="right" size={16} width={2} />
      </button>
      {logs.length ? (
        <>
          <button type="button" className="bw-row bw-plain" onClick={() => setLogsOpen(!logsOpen)} aria-expanded={logsOpen}>
            <span className="bw-name">Network logs</span>
            <Icon name={logsOpen ? 'up' : 'down'} size={16} width={2} />
          </button>
          {logsOpen ? (
            <div className="bw-box bw-mono bw-wrap bw-small">
              {logs.map((l, i) => <div key={i}>{l.message || l.msg || JSON.stringify(l)}</div>)}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
};

const ResultRow = ({ ok, name, error }) => (
  <div className="bw-result" data-testid="bw-phone-test-result">
    <span className={ok ? 'bw-ok' : 'bw-danger'} role="img" aria-label={ok ? 'passed' : 'failed'}><Icon name={ok ? 'pass' : 'fail'} width={2} /></span>
    <div className="bw-grow">
      <div>{name}</div>
      {!ok && error ? <div className="bw-mono bw-danger bw-small bw-wrap">{error}</div> : null}
    </div>
  </div>
);

const TestsView = ({ item }) => {
  const groups = [
    ['Pre-request tests', item.preRequestTestResults],
    ['Tests', item.testResults],
    ['Post-response tests', item.postResponseTestResults]
  ].filter(([, r]) => r && r.length);
  const asserts = item.assertionResults || [];
  const errors = [item.preRequestScriptErrorMessage, item.postResponseScriptErrorMessage, item.testScriptErrorMessage].filter(Boolean);
  const { total, passed } = testSummary(item);
  if (!total && !errors.length) return <Empty>This request has no tests or assertions.</Empty>;
  return (
    <div className="bw-scroll">
      <div className="bw-status-inline bw-pad-x">
        <span className="bw-ok">{passed} passed</span>
        {total - passed ? <span className="bw-danger">{total - passed} failed</span> : null}
      </div>
      {errors.map((e) => <div key={e} className="bw-error-box bw-mono">{e}</div>)}
      {groups.map(([title, results]) => (
        <section key={title}>
          <h3 className="bw-label bw-pad-x">{title}</h3>
          {results.map((r) => <ResultRow key={r.uid || r.description} ok={r.status === 'pass'} name={r.description} error={r.error} />)}
        </section>
      ))}
      {asserts.length ? (
        <section>
          <h3 className="bw-label bw-pad-x">Assertions</h3>
          {asserts.map((r) => <ResultRow key={r.uid} ok={r.status === 'pass'} name={`${r.lhsExpr} ${r.rhsExpr}`} error={r.error} />)}
        </section>
      ) : null}
    </div>
  );
};

// The search bar that replaces the header: text search or a JSONPath filter.
const FindBar = ({ mode, setMode, query, setQuery, count, current, setCurrent, isJson, onDone }) => (
  <>
    <header className="bw-phone-header bw-find">
      <label className="bw-search bw-grow">
        <span className="bw-sr">{mode === 'text' ? 'Search the response body' : 'JSONPath filter'}</span>
        <Icon name="search" size={15} width={2} />
        <input
          type="search"
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCurrent(0);
          }}
          placeholder={mode === 'text' ? 'Search' : '$.items[*].id'}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-testid="bw-phone-find-input"
        />
        {mode === 'text' && query ? <span className="bw-find-count" data-testid="bw-phone-find-count">{count ? `${current + 1} / ${count}` : '0'}</span> : null}
      </label>
      {mode === 'text' ? (
        <>
          <IconButton icon="up" label="Previous match" disabled={!count} onClick={() => setCurrent((current - 1 + count) % count)} />
          <IconButton icon="down" label="Next match" disabled={!count} onClick={() => setCurrent((current + 1) % count)} />
        </>
      ) : null}
      <button type="button" className="bw-text-button bw-brand-text" onClick={onDone} data-testid="bw-phone-find-done">Done</button>
    </header>
    {isJson ? (
      <Tabs
        label="Find mode"
        active={mode}
        onChange={(m) => {
          setMode(m);
          setQuery('');
        }}
        tabs={[{ key: 'text', label: 'Search text' }, { key: 'path', label: 'Filter by JSON path' }]}
      />
    ) : null}
  </>
);

export const ResponseScreen = ({ item, collection, paneTab, setPaneTab, inFlight, onBack, onSend, onCancel, onMenu, onCopyCurl }) => {
  const response = item.response;
  const [finding, setFinding] = useState(false);
  const [mode, setMode] = useState('text');
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const [count, setCount] = useState(0);
  const { initialFormat } = useInitialResponseFormat(response?.dataBuffer, response?.headers);
  const isJson = initialFormat === 'json';
  const tab = paneTab || 'response';
  const { total, passed } = testSummary(item);
  const headerCount = headerEntries(response?.headers).length;

  const closeFind = () => {
    setFinding(false);
    setQuery('');
    setMode('text');
  };

  return (
    <div className="bw-screen" data-testid="bw-phone-response">
      {finding ? (
        <FindBar mode={mode} setMode={setMode} query={query} setQuery={setQuery} count={count} current={current} setCurrent={setCurrent} isJson={isJson} onDone={closeFind} />
      ) : (
        <Header
          onBack={onBack}
          backLabel="Back to request"
          actions={(
            <>
              <IconButton icon="search" label="Search the response" onClick={() => { setPaneTab('response'); setFinding(true); }} disabled={!response || !!response.error} testId="bw-phone-find" />
              <IconButton icon="more" label="More: copy, share, save" onClick={onMenu} disabled={!response} testId="bw-phone-response-menu" />
            </>
          )}
        >
          <MethodLabel method={item.type === 'http-request' ? (item.draft || item).request?.method : 'GQL'} />
          <span className="bw-title-text">{item.name}</span>
        </Header>
      )}

      {inFlight ? (
        <div className="bw-sending" data-testid="bw-phone-sending">
          <span className="bw-spinner" aria-hidden="true" />
          <span>Sending…</span>
          <button type="button" className="bw-button bw-secondary" onClick={onCancel} data-testid="bw-phone-cancel">Cancel</button>
        </div>
      ) : null}

      {!inFlight && !response ? <Empty>No response yet. Tap Send to send the request.</Empty> : null}

      {!inFlight && response ? (
        <>
          {!finding ? (
            <div className="bw-status-line">
              {response.status && !response.isError ? (
                <span className={`bw-status bw-${statusTone(response.status)}`} data-testid="bw-phone-status">{response.status} {response.statusText}</span>
              ) : (
                <span className="bw-status bw-danger" data-testid="bw-phone-status">Error</span>
              )}
              {response.duration != null ? <span className="bw-muted">{response.duration} ms</span> : null}
              {response.size != null ? <span className="bw-muted">{formatSize(response.size)}</span> : null}
              <span className="bw-grow" />
              <span className="bw-subtle bw-small">{timeOf(item)}</span>
            </div>
          ) : null}
          {!finding ? (
            <Tabs
              label="Response"
              active={tab}
              onChange={setPaneTab}
              testId="bw-phone-response-tabs"
              tabs={[
                { key: 'response', label: 'Response' },
                { key: 'headers', label: 'Headers', count: headerCount || null },
                { key: 'timeline', label: 'Timeline' },
                { key: 'tests', label: 'Tests', count: total ? `${passed}/${total}` : null, countTone: total && passed < total ? 'danger' : null }
              ]}
            />
          ) : null}
          <div className="bw-pane">
            {response.error && (tab === 'response' || finding) ? (
              <div className="bw-error-box bw-mono" data-testid="bw-phone-response-error">{String(response.error)}</div>
            ) : null}
            {!response.error && (tab === 'response' || finding) ? (
              <BodyView
                item={item}
                collection={collection}
                filter={finding && mode === 'path' ? query.trim() || undefined : undefined}
                find={finding && mode === 'text' ? { query, current, onCount: setCount } : null}
              />
            ) : null}
            {!finding && tab === 'headers' ? <HeadersView headers={response.headers} /> : null}
            {!finding && tab === 'timeline' ? <TimelineView item={item} onCopyCurl={onCopyCurl} onTab={setPaneTab} /> : null}
            {!finding && tab === 'tests' ? <TestsView item={item} /> : null}
          </div>
        </>
      ) : null}

      <div className="bw-bottom">
        <button type="button" className="bw-button bw-outline bw-block" onClick={onSend} disabled={inFlight} data-testid="bw-phone-send-again">Send again</button>
      </div>
    </div>
  );
};
