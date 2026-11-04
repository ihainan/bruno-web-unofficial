/*
 * The request's tabs on a phone: params, body, headers, auth, vars, script
 * and tests. Every edit goes through upstream's reducers, so it becomes the
 * request's draft exactly as an edit in the desktop panes would.
 */
'use no memo'; // React Compiler mis-memoizes optional chains here (env?.variables read as env.variables).
import React, { useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import get from 'lodash/get';
import xmlFormat from 'xml-formatter';
import toast from 'react-hot-toast';
import {
  setQueryParams,
  updatePathParam,
  setRequestHeaders,
  setFormUrlEncodedParams,
  setMultipartFormParams,
  setRequestVars,
  updateRequestBodyMode,
  updateRequestBody,
  updateRequestGraphqlQuery,
  updateRequestGraphqlVariables,
  updateRequestAuthMode,
  updateAuth,
  updateRequestScript,
  updateResponseScript,
  updateRequestTests
} from 'providers/ReduxStore/slices/collections';
import { browseFiles, saveRequest } from 'providers/ReduxStore/slices/collections/actions';
import { getTreePathFromCollectionToItem } from 'utils/collections';
import { getEffectiveAuthSource } from 'utils/auth';
import { uuid, prettifyJsonString } from 'utils/common';
import { parseBulkKeyValue, serializeBulkKeyValue } from 'utils/common/bulkKeyValueUtils';
import { getRelativePathWithinBasePath } from 'utils/common/path';
import { getMultipartAutoContentType } from 'utils/common/multipartContentType';
import { useTheme } from 'providers/Theme';
import CodeEditor from 'components/CodeEditor';
import AuthFields from 'components/RequestPane/Auth/AuthFields';
import InheritedAuth from 'components/RequestPane/Auth/InheritedAuth';
import { Icon, Sheet, VarText, Empty } from './ui';

export const requestOf = (item) => (item.draft ? item.draft.request : item.request) || {};

const useCodeFont = () => {
  const preferences = useSelector((state) => state.app.preferences);
  return { font: get(preferences, 'font.codeFont', 'default'), fontSize: get(preferences, 'font.codeFontSize') };
};

// A value that shows its {{variables}} coloured, and becomes a text field
// when tapped.
export const VarInput = ({ value, onChange, placeholder, variables, onVariable, label, testId, mono }) => {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input
        className={`bw-cell-input${mono ? ' bw-mono' : ''}`}
        aria-label={label}
        autoFocus
        value={value || ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setEditing(false)}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        data-testid={testId}
      />
    );
  }
  return (
    <div
      className={`bw-cell-display${mono ? ' bw-mono' : ''}`}
      role="textbox"
      tabIndex={0}
      aria-label={label}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setEditing(true)}
      data-testid={testId ? `${testId}-view` : undefined}
    >
      <VarText text={value} variables={variables} onVariable={onVariable} placeholder={placeholder} />
    </div>
  );
};

// Rows of name / value pairs with a switch each, as in upstream's tables.
// `onChange` gets the whole new list (upstream's bulk setters take that).
export const KeyValueTable = ({ rows, onChange, variables, onVariable, addLabel, testId, nameLabel = 'Name', valueLabel = 'Value', bulk, fixedNames, renderValue }) => {
  const [focus, setFocus] = useState(null);
  const [bulkText, setBulkText] = useState(null);
  const set = (uid, patch) => onChange(rows.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  const add = () => {
    const uid = uuid();
    onChange([...rows, { uid, name: '', value: '', enabled: true }]);
    setFocus(uid);
  };
  return (
    <>
      {bulk ? (
        <div className="bw-pane-tools">
          <button type="button" className="bw-text-button bw-link-text" onClick={() => setBulkText(serializeBulkKeyValue(rows))} data-testid={`${testId}-bulk`}>Bulk Edit</button>
        </div>
      ) : null}
      <div className="bw-table" data-testid={testId}>
        <div className="bw-table-head" aria-hidden="true">
          <span />
          <span>{nameLabel}</span>
          <span>{valueLabel}</span>
          <span />
        </div>
        {rows.map((r) => (
          <div className="bw-table-row" key={r.uid} data-testid={`${testId}-row`}>
            <label className="bw-check">
              <span className="bw-sr">Enable {r.name}</span>
              <input type="checkbox" checked={!!r.enabled} onChange={(e) => set(r.uid, { enabled: e.target.checked })} />
            </label>
            {fixedNames ? (
              <span className="bw-cell-fixed">{r.name}</span>
            ) : (
              <input
                className="bw-cell-input"
                aria-label={nameLabel}
                value={r.name}
                autoFocus={focus === r.uid}
                placeholder={nameLabel}
                onChange={(e) => set(r.uid, { name: e.target.value })}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                data-testid={`${testId}-name`}
              />
            )}
            {renderValue ? renderValue(r, (patch) => set(r.uid, patch)) : (
              <VarInput
                value={r.value}
                onChange={(v) => set(r.uid, { value: v })}
                placeholder={valueLabel}
                label={`${valueLabel} of ${r.name || 'new row'}`}
                variables={variables}
                onVariable={onVariable}
                testId={`${testId}-value`}
              />
            )}
            {fixedNames ? <span /> : (
              <button type="button" className="bw-row-remove" aria-label={`Remove ${r.name || 'row'}`} onClick={() => onChange(rows.filter((x) => x.uid !== r.uid))}>
                <Icon name="close" size={14} width={2} />
              </button>
            )}
          </div>
        ))}
        {addLabel ? (
          <button type="button" className="bw-table-add" onClick={add} data-testid={`${testId}-add`}>
            <Icon name="plus" size={14} width={2} />
            {addLabel}
          </button>
        ) : null}
      </div>
      {bulkText !== null ? (
        <Sheet
          title="Bulk Edit"
          onClose={() => setBulkText(null)}
          left={<button type="button" className="bw-text-button" onClick={() => setBulkText(null)}>Cancel</button>}
          right={(
            <button
              type="button"
              className="bw-text-button bw-brand-text"
              onClick={() => {
                const old = new Map(rows.map((r) => [r.name, r]));
                onChange(parseBulkKeyValue(bulkText).map((r) => ({ ...(old.get(r.name) || {}), uid: old.get(r.name)?.uid || uuid(), ...r })));
                setBulkText(null);
              }}
              data-testid={`${testId}-bulk-done`}
            >
              Done
            </button>
          )}
        >
          <p className="bw-hint-text">One per line as <code>name:value</code>. Start a line with <code>//</code> to turn it off.</p>
          <textarea className="bw-textarea bw-mono" rows={10} value={bulkText} onChange={(e) => setBulkText(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid={`${testId}-bulk-text`} />
        </Sheet>
      ) : null}
    </>
  );
};

const Section = ({ title, children, help }) => (
  <section className="bw-edit-section">
    {title ? <h3 className="bw-label">{title}{help ? <span className="bw-help" title={help}><Icon name="help" size={13} width={2} /></span> : null}</h3> : null}
    {children}
  </section>
);

const ParamsTab = ({ item, collection, variables, onVariable }) => {
  const dispatch = useDispatch();
  const request = requestOf(item);
  const params = request.params || [];
  const query = params.filter((p) => p.type === 'query');
  const path = params.filter((p) => p.type === 'path');
  const ids = { collectionUid: collection.uid, itemUid: item.uid };
  return (
    <div className="bw-scroll bw-pad">
      <Section title="Query">
        <KeyValueTable
          rows={query}
          onChange={(rows) => dispatch(setQueryParams({ ...ids, params: rows.map((p) => ({ ...p, type: 'query' })) }))}
          variables={variables}
          onVariable={onVariable}
          addLabel="Add param"
          bulk
          testId="bw-phone-params"
        />
      </Section>
      <Section title="Path" help="Path params come from the URL, for example /orders/:id">
        {path.length ? (
          <KeyValueTable
            rows={path}
            fixedNames
            onChange={(rows) => rows.forEach((p, i) => {
              if (p !== path[i]) dispatch(updatePathParam({ ...ids, pathParam: p }));
            })}
            variables={variables}
            onVariable={onVariable}
            testId="bw-phone-path-params"
          />
        ) : <p className="bw-hint-text">No path params in this URL.</p>}
      </Section>
    </div>
  );
};

// The collection's and folders' headers this request also sends.
const inheritedHeaders = (collection, item) => {
  const out = [];
  const add = (headers, source) => (headers || []).filter((h) => h.enabled).forEach((h) => out.push({ ...h, source }));
  add(get(collection, 'draft.root.request.headers') || get(collection, 'root.request.headers'), 'Collection');
  for (const node of getTreePathFromCollectionToItem(collection, item)) {
    if (node.uid !== item.uid && node.type === 'folder') add(get(node, 'draft.request.headers') || get(node, 'root.request.headers'), node.name);
  }
  return out;
};

const HeadersTab = ({ item, collection, variables, onVariable }) => {
  const dispatch = useDispatch();
  const headers = requestOf(item).headers || [];
  const inherited = useMemo(() => inheritedHeaders(collection, item), [collection, item]);
  return (
    <div className="bw-scroll bw-pad">
      <KeyValueTable
        rows={headers}
        onChange={(rows) => dispatch(setRequestHeaders({ collectionUid: collection.uid, itemUid: item.uid, headers: rows }))}
        variables={variables}
        onVariable={onVariable}
        addLabel="Add header"
        bulk
        testId="bw-phone-headers"
      />
      {inherited.length ? (
        <Section title="Inherited">
          <div className="bw-table bw-readonly">
            {inherited.map((h, i) => (
              <div className="bw-table-row bw-inherited" key={`${h.source}-${h.name}-${i}`}>
                <span className="bw-cell-fixed">{h.name}</span>
                <span className="bw-cell-fixed"><VarText text={h.value} variables={variables} /></span>
                <span className="bw-source">{h.source}</span>
              </div>
            ))}
          </div>
          <p className="bw-hint-text">A header with the same name here replaces the inherited one.</p>
        </Section>
      ) : null}
    </div>
  );
};

const BODY_MODES = [
  ['none', 'No Body'],
  ['json', 'JSON'],
  ['xml', 'XML'],
  ['text', 'Text'],
  ['sparql', 'SPARQL'],
  ['formUrlEncoded', 'Form URL Encoded'],
  ['multipartForm', 'Multipart Form'],
  ['file', 'File / Binary']
];
const CODE_MODES = { json: 'application/ld+json', xml: 'application/xml', text: 'application/text', sparql: 'application/sparql-query' };

export const InlineSelect = ({ value, options, onChange, label, testId, className = '' }) => (
  <label className={`bw-inline-select ${className}`}>
    <span className="bw-sr">{label}</span>
    <select value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
      {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
    </select>
    <span className="bw-inline-select-text" aria-hidden="true">{(options.find(([v]) => v === value) || [value, value])[1]}</span>
    <Icon name="down" size={11} width={2.5} />
  </label>
);

const Code = ({ value, onEdit, mode, item, collection, docKey, editorRef, testId, hints }) => {
  const { displayedTheme } = useTheme();
  const { font, fontSize } = useCodeFont();
  return (
    <div className="bw-code" data-testid={testId}>
      <CodeEditor
        ref={editorRef}
        value={value || ''}
        onEdit={onEdit}
        mode={mode}
        theme={displayedTheme}
        font={font}
        fontSize={fontSize}
        collection={collection}
        item={item}
        enableVariableHighlighting
        showHintsFor={hints}
        docKey={docKey}
      />
    </div>
  );
};

const fileName = (p) => String(p).split(/[\\/]/).pop();

const pickFiles = (dispatch, collection, multi) => dispatch(browseFiles([], multi ? ['multiSelections'] : []))
  .then((paths) => (paths || []).map((p) => getRelativePathWithinBasePath(collection.pathname, p) || p))
  .catch(() => []);

const MultipartValue = ({ row, set, collection, variables, onVariable }) => {
  const dispatch = useDispatch();
  const files = Array.isArray(row.value) ? row.value : [];
  const setFiles = (next) => set(next.length ? { type: 'file', value: next, contentType: getMultipartAutoContentType(next) } : { type: 'text', value: '', contentType: '' });
  return (
    <div className="bw-multipart-value">
      <select className="bw-kind" aria-label={`Kind of ${row.name}`} value={row.type === 'file' ? 'file' : 'text'} onChange={(e) => set(e.target.value === 'file' ? { type: 'file', value: [], contentType: '' } : { type: 'text', value: '', contentType: '' })}>
        <option value="text">Text</option>
        <option value="file">File</option>
      </select>
      {row.type === 'file' ? (
        <div className="bw-chips">
          {files.map((f) => (
            <span className="bw-chip" key={f}>
              {fileName(f)}
              <button type="button" aria-label={`Remove ${fileName(f)}`} onClick={() => setFiles(files.filter((x) => x !== f))}><Icon name="close" size={12} width={2.25} /></button>
            </span>
          ))}
          <button type="button" className="bw-chip bw-chip-add" onClick={() => pickFiles(dispatch, collection, true).then((paths) => paths.length && setFiles([...files, ...paths]))} data-testid="bw-phone-choose-file">
            <Icon name="plus" size={12} width={2.25} />Choose file
          </button>
        </div>
      ) : (
        <VarInput value={row.value} onChange={(v) => set({ value: v })} placeholder="Value" label={`Value of ${row.name}`} variables={variables} onVariable={onVariable} />
      )}
    </div>
  );
};

const FileBody = ({ item, collection }) => {
  const dispatch = useDispatch();
  const files = requestOf(item).body?.file || [];
  const set = (next) => dispatch(updateRequestBody({ itemUid: item.uid, collectionUid: collection.uid, content: next }));
  return (
    <div className="bw-file-list">
      {files.map((f) => (
        <div className="bw-file-row" key={f.uid}>
          <label className="bw-check">
            <span className="bw-sr">Send {fileName(f.filePath)}</span>
            <input type="radio" name="bw-file-body" checked={!!f.selected} onChange={() => set(files.map((x) => ({ ...x, selected: x.uid === f.uid })))} />
          </label>
          <span className="bw-grow">
            <span className="bw-file-name">{f.filePath ? fileName(f.filePath) : 'No file'}</span>
            <span className="bw-subtle bw-small">{f.contentType}</span>
          </span>
          <button type="button" className="bw-row-remove" aria-label="Remove file" onClick={() => set(files.filter((x) => x.uid !== f.uid))}><Icon name="close" size={14} width={2} /></button>
        </div>
      ))}
      <button
        type="button"
        className="bw-table-add"
        onClick={() => pickFiles(dispatch, collection, false).then(([p]) => p && set([...files, { uid: uuid(), filePath: p, contentType: getMultipartAutoContentType([p]), description: '', selected: !files.some((x) => x.selected) }]))}
      >
        <Icon name="plus" size={14} width={2} />Choose file
      </button>
    </div>
  );
};

const BodyTab = ({ item, collection, variables, onVariable }) => {
  const dispatch = useDispatch();
  const request = requestOf(item);
  const ids = { itemUid: item.uid, collectionUid: collection.uid };
  if (item.type === 'graphql-request') {
    const gql = request.body?.graphql || {};
    return (
      <div className="bw-scroll bw-pad bw-stack">
        <Section title="Query">
          <Code value={gql.query} onEdit={(query) => dispatch(updateRequestGraphqlQuery({ ...ids, query }))} mode="graphql" item={item} collection={collection} docKey="bw-phone:gql-query" testId="bw-phone-gql-query" />
        </Section>
        <Section title="Variables">
          <Code value={gql.variables} onEdit={(variables) => dispatch(updateRequestGraphqlVariables({ ...ids, variables }))} mode="application/ld+json" item={item} collection={collection} docKey="bw-phone:gql-vars" />
        </Section>
      </div>
    );
  }
  const mode = request.body?.mode || 'none';
  const body = request.body || {};
  const prettify = () => {
    try {
      const content = mode === 'json' ? prettifyJsonString(body.json) : xmlFormat(body.xml || '', { collapseContent: true });
      dispatch(updateRequestBody({ ...ids, content }));
    } catch (e) {
      toast.error(`Could not format the ${mode.toUpperCase()}`);
    }
  };
  return (
    <div className="bw-body-tab">
      <div className="bw-pane-tools">
        <InlineSelect value={mode} options={BODY_MODES} onChange={(m) => dispatch(updateRequestBodyMode({ ...ids, mode: m }))} label="Body type" testId="bw-phone-body-mode" className="bw-brand-text" />
        {mode === 'json' || mode === 'xml' ? <button type="button" className="bw-text-button" onClick={prettify}>Prettify</button> : null}
      </div>
      {mode === 'none' ? <Empty>This request has no body.</Empty> : null}
      {CODE_MODES[mode] ? (
        <div className="bw-code-fill-wrap">
          <Code
            value={body[mode]}
            onEdit={(content) => dispatch(updateRequestBody({ ...ids, content }))}
            mode={CODE_MODES[mode]}
            item={item}
            collection={collection}
            docKey={`bw-phone:body-${mode}`}
            testId="bw-phone-body-editor"
          />
        </div>
      ) : null}
      {mode === 'formUrlEncoded' ? (
        <div className="bw-scroll bw-pad">
          <KeyValueTable rows={body.formUrlEncoded || []} onChange={(params) => dispatch(setFormUrlEncodedParams({ ...ids, params }))} variables={variables} onVariable={onVariable} addLabel="Add field" bulk testId="bw-phone-form" />
        </div>
      ) : null}
      {mode === 'multipartForm' ? (
        <div className="bw-scroll bw-pad">
          <KeyValueTable
            rows={body.multipartForm || []}
            onChange={(params) => dispatch(setMultipartFormParams({ ...ids, params }))}
            addLabel="Add field"
            testId="bw-phone-multipart"
            renderValue={(row, set) => <MultipartValue row={row} set={set} collection={collection} variables={variables} onVariable={onVariable} />}
          />
          <p className="bw-hint-text">Files can come from your photos, the camera, or Files.</p>
        </div>
      ) : null}
      {mode === 'file' ? <div className="bw-scroll bw-pad"><FileBody item={item} collection={collection} /></div> : null}
    </div>
  );
};

const AUTH_MODES = [
  ['inherit', 'Inherit'],
  ['none', 'No Auth'],
  ['basic', 'Basic Auth'],
  ['bearer', 'Bearer Token'],
  ['apikey', 'API Key'],
  ['digest', 'Digest Auth'],
  ['oauth2', 'OAuth 2.0'],
  ['oauth1', 'OAuth 1.0'],
  ['awsv4', 'AWS Sig v4'],
  ['ntlm', 'NTLM Auth'],
  ['wsse', 'WSSE Auth'],
  ['akamai-edgegrid', 'Akamai EdgeGrid']
];

const AuthTab = ({ item, collection }) => {
  const dispatch = useDispatch();
  const request = requestOf(item);
  const mode = request.auth?.mode || 'none';
  const inheritedSource = useMemo(() => (mode === 'inherit' ? getEffectiveAuthSource(collection, item) : null), [mode, collection, item]);
  return (
    <div className="bw-scroll bw-pad bw-auth">
      <Section title="Mode">
        <label className="bw-select-field">
          <span className="bw-sr">Auth mode</span>
          <select value={mode} onChange={(e) => dispatch(updateRequestAuthMode({ itemUid: item.uid, collectionUid: collection.uid, mode: e.target.value }))} data-testid="bw-phone-auth-mode">
            {AUTH_MODES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          <Icon name="down" size={12} width={2.25} />
        </label>
      </Section>
      <div className="bw-upstream-form">
        {mode === 'inherit' ? <InheritedAuth collection={collection} item={item} inheritedSource={inheritedSource} /> : null}
        {mode === 'none' ? <p className="bw-hint-text">This request sends no credentials.</p> : null}
        {mode !== 'inherit' && mode !== 'none' ? (
          <AuthFields
            authMode={mode}
            collection={collection}
            item={item}
            request={request}
            updateAuth={updateAuth}
            save={() => dispatch(saveRequest(item.uid, collection.uid))}
          />
        ) : null}
      </div>
    </div>
  );
};

const VarsTab = ({ item, collection, variables, onVariable }) => {
  const dispatch = useDispatch();
  const vars = requestOf(item).vars || {};
  const set = (type) => (rows) => dispatch(setRequestVars({ collectionUid: collection.uid, itemUid: item.uid, type, vars: rows }));
  return (
    <div className="bw-scroll bw-pad">
      <Section title="Pre Request">
        <KeyValueTable rows={vars.req || []} onChange={set('request')} variables={variables} onVariable={onVariable} addLabel="Add variable" testId="bw-phone-req-vars" />
      </Section>
      <Section title="Post Response" help="Values are expressions such as res.body.id">
        <KeyValueTable rows={vars.res || []} onChange={set('response')} valueLabel="Expression" addLabel="Add variable" testId="bw-phone-res-vars" />
      </Section>
    </div>
  );
};

const KEYS = ['{', '}', '(', ')', '[', ']', ';', '"', "'", '.', '=', '=>', '!', '`'];

// Keys that are hard to reach on a phone keyboard, inserted at the cursor.
const SymbolBar = ({ editorRef }) => (
  <div className="bw-symbols" role="toolbar" aria-label="Symbols">
    {KEYS.map((k) => (
      <button
        key={k}
        type="button"
        // A mouse press would take focus from the editor; on a touch screen
        // cancelling the press would also cancel the tap, so only for mice.
        onPointerDown={(e) => e.pointerType === 'mouse' && e.preventDefault()}
        onClick={() => {
          const editor = editorRef.current?.editor;
          if (!editor) return;
          editor.replaceSelection(k);
          editor.focus();
        }}
      >
        {k}
      </button>
    ))}
  </div>
);

const ScriptTab = ({ item, collection, which, setWhich }) => {
  const dispatch = useDispatch();
  const script = requestOf(item).script || {};
  const editorRef = useRef(null);
  const ids = { itemUid: item.uid, collectionUid: collection.uid };
  const pre = which !== 'post';
  return (
    <div className="bw-script-tab">
      <div className="bw-pad-x bw-pad-top">
        <div className="bw-seg" role="group" aria-label="Script stage">
          <button type="button" aria-pressed={pre} onClick={() => setWhich('pre')} data-testid="bw-phone-script-pre">Pre Request{script.req ? <span className="bw-tab-dot" /> : null}</button>
          <button type="button" aria-pressed={!pre} onClick={() => setWhich('post')} data-testid="bw-phone-script-post">Post Response{script.res ? <span className="bw-tab-dot" /> : null}</button>
        </div>
      </div>
      <div className="bw-code-fill-wrap">
        <Code
          key={pre ? 'pre' : 'post'}
          editorRef={editorRef}
          value={pre ? script.req : script.res}
          onEdit={(s) => dispatch(pre ? updateRequestScript({ ...ids, script: s }) : updateResponseScript({ ...ids, script: s }))}
          mode="javascript"
          item={item}
          collection={collection}
          hints={pre ? ['req', 'bru'] : ['req', 'res', 'bru']}
          docKey={pre ? 'bw-phone:script-pre' : 'bw-phone:script-post'}
          testId="bw-phone-script-editor"
        />
      </div>
      <SymbolBar editorRef={editorRef} />
    </div>
  );
};

const TestsTab = ({ item, collection }) => {
  const dispatch = useDispatch();
  const editorRef = useRef(null);
  return (
    <div className="bw-script-tab">
      <div className="bw-code-fill-wrap">
        <Code
          editorRef={editorRef}
          value={requestOf(item).tests}
          onEdit={(tests) => dispatch(updateRequestTests({ itemUid: item.uid, collectionUid: collection.uid, tests }))}
          mode="javascript"
          item={item}
          collection={collection}
          hints={['req', 'res', 'bru']}
          docKey="bw-phone:tests"
          testId="bw-phone-tests-editor"
        />
      </div>
      <SymbolBar editorRef={editorRef} />
    </div>
  );
};

export const requestTabs = (item) => {
  const request = requestOf(item);
  const enabled = (rows) => (rows || []).filter((r) => r.enabled).length || null;
  const gql = item.type === 'graphql-request';
  const mode = request.body?.mode;
  return [
    { key: 'params', label: 'Params', count: enabled(request.params) },
    { key: 'body', label: gql ? 'Query' : 'Body', dot: gql ? !!request.body?.graphql?.query : mode && mode !== 'none' },
    { key: 'headers', label: 'Headers', count: enabled(request.headers) },
    { key: 'auth', label: 'Auth', dot: !!request.auth?.mode && !['none', 'inherit'].includes(request.auth.mode) },
    { key: 'vars', label: 'Vars', count: (enabled(request.vars?.req) || 0) + (enabled(request.vars?.res) || 0) || null },
    { key: 'script', label: 'Script', dot: !!(request.script?.req || request.script?.res) },
    { key: 'tests', label: 'Tests', dot: !!request.tests }
  ];
};

export const RequestEditor = ({ tab, ...props }) => {
  const [which, setWhich] = useState('pre');
  switch (tab) {
    case 'body': return <BodyTab {...props} />;
    case 'headers': return <HeadersTab {...props} />;
    case 'auth': return <AuthTab {...props} />;
    case 'vars': return <VarsTab {...props} />;
    case 'script': return <ScriptTab {...props} which={which} setWhich={setWhich} />;
    case 'tests': return <TestsTab {...props} />;
    default: return <ParamsTab {...props} />;
  }
};
