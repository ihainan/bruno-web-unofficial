/*
 * Panels that slide up over a screen: environments, a variable's value, the
 * request / folder / response menus and the small forms they open.
 */
'use no memo'; // React Compiler mis-memoizes optional chains here (env?.variables read as env.variables).
import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import cloneDeep from 'lodash/cloneDeep';
import toast from 'react-hot-toast';
import { setEnvironmentsDraft, clearEnvironmentsDraft, addResponseExample } from 'providers/ReduxStore/slices/collections';
import {
  selectEnvironment,
  saveEnvironment,
  updateVariableInScope,
  cloneItem,
  renameItem,
  deleteItem,
  newFolder,
  newHttpRequest,
  newGrpcRequest,
  newWsRequest,
  saveRequest,
  saveFolderRoot,
  closeTabs,
  handleMultipleCollectionItemsDrop
} from 'providers/ReduxStore/slices/collections/actions';
import {
  selectGlobalEnvironment,
  saveGlobalEnvironment,
  setGlobalEnvironmentDraft,
  clearGlobalEnvironmentDraft
} from 'providers/ReduxStore/slices/global-environments';
import { getVariableScope, isVariableSecret, isItemAFolder, getAllVariables } from 'utils/collections';
import { resolveInheritedAuth } from 'utils/auth';
import { uuid, formatResponse, getContentType } from 'utils/common';
import { sanitizeName } from 'utils/common/regex';
import { getRequestFromCurlCommand } from 'utils/curl';
import { getLanguages } from 'utils/codegenerator/targets';
import { detectContentTypeFromBase64 } from 'utils/response';
import { getExampleBodyType } from 'utils/responseBodyProcessor';
import { generateSnippet } from 'components/Sidebar/Collections/Collection/CollectionItem/GenerateCodeItem/utils/snippet-generator';
import { Sheet, MenuRow, MenuDivider, Icon, Empty, methodClass } from './ui';
import { bySeq } from './list';

export const copyText = async (text, what = 'Copied') => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(what);
  } catch (e) {
    toast.error('Could not copy');
  }
};

const TextButton = ({ children, brand, onClick, disabled, testId }) => (
  <button type="button" className={`bw-text-button${brand ? ' bw-brand-text bw-strong' : ''}`} onClick={onClick} disabled={disabled} data-testid={testId}>{children}</button>
);

// ------------------------------------------------------------ environments

const SecretField = ({ value, onChange, label }) => {
  const [shown, setShown] = useState(false);
  return (
    <span className="bw-field-row">
      <input className="bw-input bw-mono" type={shown ? 'text' : 'password'} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <button type="button" className="bw-icon-button bw-small-icon" aria-label={shown ? 'Hide value' : 'Show value'} onClick={() => setShown(!shown)}>
        <Icon name={shown ? 'eyeOff' : 'eye'} />
      </button>
    </span>
  );
};

const VariableRows = ({ variables, onChange, testId }) => {
  const set = (uid, patch) => onChange(variables.map((v) => (v.uid === uid ? { ...v, ...patch } : v)));
  return (
    <>
      {variables.map((v) => (
        <div className="bw-env-var" key={v.uid} data-testid={`${testId}-row`}>
          <div className="bw-env-var-head">
            <input className="bw-env-name" aria-label="Variable name" value={v.name} placeholder="name" onChange={(e) => set(v.uid, { name: e.target.value })} autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid={`${testId}-name`} />
            {v.secret ? <span className="bw-subtle bw-small">secret</span> : null}
            <label className="bw-check bw-check-inline">
              <span className="bw-sr">Enable {v.name}</span>
              <input type="checkbox" checked={!!v.enabled} onChange={(e) => set(v.uid, { enabled: e.target.checked })} />
            </label>
            <button type="button" className="bw-row-remove" aria-label={`Remove ${v.name || 'variable'}`} onClick={() => onChange(variables.filter((x) => x.uid !== v.uid))}><Icon name="close" size={14} width={2} /></button>
          </div>
          {v.secret ? (
            <SecretField value={v.value ?? ''} onChange={(value) => set(v.uid, { value })} label={`Value of ${v.name}`} />
          ) : (
            <input className="bw-input bw-mono" aria-label={`Value of ${v.name}`} value={v.value ?? ''} onChange={(e) => set(v.uid, { value: e.target.value })} autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid={`${testId}-value`} />
          )}
        </div>
      ))}
      <button
        type="button"
        className="bw-text-button bw-brand-text bw-add-line"
        onClick={() => onChange([...variables, { uid: uuid(), name: '', value: '', type: 'text', enabled: true, secret: false }])}
        data-testid={`${testId}-add`}
      >
        <Icon name="plus" size={15} width={2} />Add variable
      </button>
    </>
  );
};

// Upstream keeps one environment draft per collection (and one for the global
// environments): a draft for another environment is saved or dropped first,
// or editing this one would overwrite it.
// A draft whose uid starts with "dotenv:" is an unsaved .env file (upstream's
// RequestTab saves those its own way): it can only be dropped here.
const OtherDraft = ({ draft, name, onSave, onDiscard, onFull }) => {
  const dotenv = String(draft.environmentUid).startsWith('dotenv:');
  return (
    <div className="bw-notice" role="status" data-testid="bw-phone-env-other-draft">
      <span className="bw-grow">{dotenv ? 'Unsaved changes to a .env file.' : `Unsaved changes in ${name}.`}</span>
      <button type="button" className="bw-text-button" onClick={onDiscard}>Discard</button>
      {dotenv ? (
        onFull ? <button type="button" className="bw-text-button bw-brand-text bw-strong" onClick={onFull}>Open</button> : null
      ) : (
        <button type="button" className="bw-text-button bw-brand-text bw-strong" onClick={onSave}>Save</button>
      )}
    </div>
  );
};

// Clears a draft after it was saved, unless it changed while saving (the
// saved copy is then older than what is on the screen).
const clearIfUnchanged = (read, saved, clear) => (dispatch, getState) => {
  if (read(getState()) === saved) dispatch(clear);
};

const EnvChoice = ({ name, active, onPick, testId }) => (
  <button type="button" role="radio" aria-checked={active} className={`bw-choice${active ? ' bw-active' : ''}`} onClick={onPick} data-testid={testId}>
    <span className="bw-grow">{name}</span>
    {active ? <Icon name="check" width={2.25} /> : null}
  </button>
);

const GlobalEnvView = ({ onBack, onFull }) => {
  const dispatch = useDispatch();
  const { globalEnvironments, activeGlobalEnvironmentUid, globalEnvironmentDraft } = useSelector((state) => state.globalEnvironments);
  const env = globalEnvironments.find((e) => e.uid === activeGlobalEnvironmentUid);
  const draft = globalEnvironmentDraft && globalEnvironmentDraft.environmentUid === env?.uid ? globalEnvironmentDraft.variables : null;
  const variables = draft || env?.variables || [];
  const other = globalEnvironmentDraft && globalEnvironmentDraft.environmentUid !== env?.uid ? globalEnvironmentDraft : null;
  const otherName = other ? (globalEnvironments.find((e) => e.uid === other.environmentUid) || {}).name : '';
  const readDraft = (state) => state.globalEnvironments.globalEnvironmentDraft;
  const saveOther = () => dispatch(saveGlobalEnvironment({ variables: cloneDeep(other.variables), environmentUid: other.environmentUid }))
    .then(() => dispatch(clearIfUnchanged(readDraft, other, clearGlobalEnvironmentDraft())))
    .catch((e) => toast.error(e?.message || 'Could not save'));
  const saving = globalEnvironmentDraft;
  const save = () => dispatch(saveGlobalEnvironment({ variables: cloneDeep(variables), environmentUid: env.uid }))
    .then(() => {
      dispatch(clearIfUnchanged(readDraft, saving, clearGlobalEnvironmentDraft()));
      toast.success('Saved');
    })
    .catch((e) => toast.error(e?.message || 'Could not save'));
  return (
    <>
      <div className="bw-sheet-subhead">
        <button type="button" className="bw-text-button" onClick={onBack}><Icon name="back" size={16} width={2} />Environments</button>
        {draft ? <TextButton brand onClick={save} testId="bw-phone-global-save">Save</TextButton> : null}
      </div>
      <div role="radiogroup" aria-label="Global environment" className="bw-choices">
        <EnvChoice name="No Global Environment" active={!activeGlobalEnvironmentUid} onPick={() => dispatch(selectGlobalEnvironment({ environmentUid: null }))} />
        {globalEnvironments.map((e) => (
          <EnvChoice key={e.uid} name={e.name} active={e.uid === activeGlobalEnvironmentUid} onPick={() => dispatch(selectGlobalEnvironment({ environmentUid: e.uid }))} />
        ))}
      </div>
      {other ? <OtherDraft draft={other} name={otherName || 'another environment'} onSave={saveOther} onDiscard={() => dispatch(clearGlobalEnvironmentDraft())} onFull={onFull} /> : null}
      {env && !other ? (
        <>
          <h3 className="bw-label bw-pad-x">{env.name} variables{draft ? <span className="bw-draft-text">Unsaved changes</span> : null}</h3>
          <div className="bw-pad-x">
            <VariableRows variables={variables} onChange={(v) => dispatch(setGlobalEnvironmentDraft({ environmentUid: env.uid, variables: v }))} testId="bw-phone-global-var" />
          </div>
        </>
      ) : null}
    </>
  );
};

export const EnvSheet = ({ collection, onClose, onFull }) => {
  const dispatch = useDispatch();
  const [view, setView] = useState('collection');
  const { globalEnvironments, activeGlobalEnvironmentUid } = useSelector((state) => state.globalEnvironments);
  const envs = collection.environments || [];
  const env = envs.find((e) => e.uid === collection.activeEnvironmentUid);
  const draft = collection.environmentsDraft && collection.environmentsDraft.environmentUid === env?.uid ? collection.environmentsDraft.variables : null;
  const variables = draft || env?.variables || [];
  const globalEnv = globalEnvironments.find((e) => e.uid === activeGlobalEnvironmentUid);
  const other = collection.environmentsDraft && collection.environmentsDraft.environmentUid !== env?.uid ? collection.environmentsDraft : null;
  const otherName = other ? (envs.find((e) => e.uid === other.environmentUid) || {}).name : '';
  const readDraft = (state) => (state.collections.collections.find((c) => c.uid === collection.uid) || {}).environmentsDraft;
  const saveOther = () => dispatch(saveEnvironment(cloneDeep(other.variables), other.environmentUid, collection.uid))
    .then(() => dispatch(clearIfUnchanged(readDraft, other, clearEnvironmentsDraft({ collectionUid: collection.uid }))))
    .catch((e) => toast.error(e?.message || 'Could not save'));
  const saving = collection.environmentsDraft;
  const save = () => dispatch(saveEnvironment(cloneDeep(variables), env.uid, collection.uid))
    .then(() => {
      dispatch(clearIfUnchanged(readDraft, saving, clearEnvironmentsDraft({ collectionUid: collection.uid })));
      toast.success('Saved');
    })
    .catch((e) => toast.error(e?.message || 'Could not save'));
  return (
    <Sheet
      title="Environment"
      tall
      onClose={onClose}
      testId="bw-phone-env-sheet"
      left={<TextButton onClick={onClose}>Close</TextButton>}
      right={view === 'collection' && draft ? <TextButton brand onClick={save} testId="bw-phone-env-save">Save</TextButton> : null}
    >
      {view === 'global' ? <GlobalEnvView onBack={() => setView('collection')} onFull={onFull} /> : (
        <>
          <div role="radiogroup" aria-label="Environment" className="bw-choices">
            <EnvChoice name="No Environment" active={!env} onPick={() => dispatch(selectEnvironment(null, collection.uid))} testId="bw-phone-env-none" />
            {envs.map((e) => (
              <EnvChoice key={e.uid} name={e.name} active={e.uid === env?.uid} onPick={() => dispatch(selectEnvironment(e.uid, collection.uid))} testId="bw-phone-env-choice" />
            ))}
          </div>
          {envs.length === 0 ? <Empty>This collection has no environments. Create one in the full interface.</Empty> : null}
          {other ? <OtherDraft draft={other} name={otherName || 'another environment'} onSave={saveOther} onDiscard={() => dispatch(clearEnvironmentsDraft({ collectionUid: collection.uid }))} onFull={onFull} /> : null}
          {env && !other ? (
            <>
              <h3 className="bw-label bw-pad-x">
                {env.name} variables
                {draft ? <span className="bw-draft-text" data-testid="bw-phone-env-unsaved">Unsaved changes</span> : null}
              </h3>
              <div className="bw-pad-x">
                <VariableRows variables={variables} onChange={(v) => dispatch(setEnvironmentsDraft({ collectionUid: collection.uid, environmentUid: env.uid, variables: v }))} testId="bw-phone-env-var" />
              </div>
            </>
          ) : null}
          <button type="button" className="bw-row bw-plain bw-gap-top" onClick={() => setView('global')} data-testid="bw-phone-global-env">
            <span className="bw-name">Global environment</span>
            <span className="bw-muted bw-small">{globalEnv ? `${globalEnv.name} · ${(globalEnv.variables || []).length} variables` : 'None'}</span>
            <Icon name="right" size={16} width={2} />
          </button>
        </>
      )}
    </Sheet>
  );
};

// ------------------------------------------------------- variable popover

const SCOPE_LABELS = { request: 'request variable', folder: 'folder variable', collection: 'collection variable', runtime: 'runtime variable', 'process.env': 'from process.env' };

export const VarPeek = ({ name, anchor, collection, item, onClose, onOpenEnv }) => {
  const dispatch = useDispatch();
  const scope = useMemo(() => getVariableScope(name, collection, item), [name, collection, item]);
  const variables = useMemo(() => getAllVariables(collection, item), [collection, item]);
  const secret = scope ? isVariableSecret(scope) : false;
  const [shown, setShown] = useState(!secret);
  const [editing, setEditing] = useState(false);
  const raw = scope ? scope.value : variables[name];
  const value = raw === undefined ? undefined : typeof raw === 'string' ? raw : JSON.stringify(raw);
  const [draft, setDraft] = useState(value ?? '');
  // The same rule as upstream's variable hover (utils/codemirror/brunoVarInfo.js):
  // an inherited value belongs to a parent environment, editing it here would
  // add an unrelated, non-secret copy to this one.
  const readonly = !scope || ['runtime', 'process.env', 'dynamic', 'oauth2', 'undefined'].includes(scope.type) || !!scope.inheritedFrom || !!scope.data?.readonly;
  const envName = (collection.environments || []).find((e) => e.uid === collection.activeEnvironmentUid)?.name;
  const where = !scope ? null : scope.type === 'environment' ? `from ${envName || 'environment'}` : scope.type === 'global' ? 'global environment' : SCOPE_LABELS[scope.type] || scope.type;

  const rect = anchor?.getBoundingClientRect?.();
  const top = rect ? Math.min(rect.bottom + 10, window.innerHeight - 220) : 120;
  const arrow = rect ? Math.max(16, Math.min(rect.left + rect.width / 2 - 16, window.innerWidth - 48)) : 40;

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = () => dispatch(updateVariableInScope(name, draft, scope, collection.uid))
    .then(() => {
      toast.success('Saved');
      onClose();
    })
    .catch((e) => toast.error(e?.message || 'Could not save'));

  return (
    <div className="bw-sheet-layer bw-popover-layer">
      <button type="button" className="bw-scrim bw-scrim-clear" aria-label="Close" onClick={onClose} />
      <div className="bw-popover" role="dialog" aria-label={`Variable ${name}`} style={{ top }} data-testid="bw-phone-var-peek">
        <span className="bw-popover-arrow" style={{ left: arrow }} aria-hidden="true" />
        <div className="bw-between">
          <span className="bw-mono bw-strong">{name}</span>
          {where ? <span className="bw-muted bw-small">{where}{scope?.inheritedFrom ? `, inherited from ${scope.inheritedFrom.name || 'a parent environment'}` : ''}</span> : null}
        </div>
        {name.startsWith('?') ? <p className="bw-hint-text">You are asked for this value each time you send.</p> : null}
        {!name.startsWith('?') && value === undefined ? (
          <p className="bw-danger bw-small" data-testid="bw-phone-var-missing">Not defined{envName ? ` in ${envName}` : ''}.</p>
        ) : null}
        {value !== undefined && !editing ? (
          <div className="bw-peek-value bw-mono" data-testid="bw-phone-var-value">
            <span className="bw-grow">{shown ? value : '••••••••'}</span>
            {secret ? (
              <button type="button" className="bw-icon-button bw-small-icon" aria-label={shown ? 'Hide value' : 'Show value'} onClick={() => setShown(!shown)}><Icon name={shown ? 'eyeOff' : 'eye'} /></button>
            ) : null}
          </div>
        ) : null}
        {editing ? (
          <span className="bw-field-row">
            <input className="bw-input bw-mono" type={shown ? 'text' : 'password'} autoFocus aria-label={`New value of ${name}`} value={draft} onChange={(e) => setDraft(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid="bw-phone-var-input" />
            {secret ? <button type="button" className="bw-icon-button bw-small-icon" aria-label={shown ? 'Hide value' : 'Show value'} onClick={() => setShown(!shown)}><Icon name={shown ? 'eyeOff' : 'eye'} /></button> : null}
          </span>
        ) : null}
        <div className="bw-popover-actions">
          {editing ? (
            <>
              <TextButton onClick={() => setEditing(false)}>Cancel</TextButton>
              <TextButton brand onClick={save} testId="bw-phone-var-save">Save</TextButton>
            </>
          ) : (
            <>
              {value !== undefined ? <button type="button" className="bw-text-button bw-link-text" onClick={() => copyText(value)}>Copy value</button> : null}
              {!readonly && value !== undefined ? <button type="button" className="bw-text-button bw-link-text" onClick={() => setEditing(true)} data-testid="bw-phone-var-edit">Edit</button> : null}
              {(!scope || scope.type === 'environment') && !name.startsWith('?') ? (
                <button type="button" className="bw-text-button bw-link-text" onClick={onOpenEnv}>{scope ? 'Open environment' : 'Add to environment'}</button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ------------------------------------------------------------ small forms

export const PromptSheet = ({ title, label, initial, action, onSubmit, onClose, testId }) => {
  const [value, setValue] = useState(initial || '');
  const [busy, setBusy] = useState(false);
  const submit = () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    Promise.resolve(onSubmit(value.trim())).then(onClose, (e) => {
      setBusy(false);
      toast.error(e?.message || 'Something went wrong');
    });
  };
  return (
    <Sheet title={title} onClose={onClose} testId={testId} left={<TextButton onClick={onClose}>Cancel</TextButton>} right={<TextButton brand onClick={submit} disabled={!value.trim() || busy} testId={`${testId}-ok`}>{action}</TextButton>}>
      <form className="bw-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="bw-field">
          <span className="bw-label">{label}</span>
          <input className="bw-input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} data-testid={`${testId}-input`} />
        </label>
      </form>
    </Sheet>
  );
};

export const ConfirmSheet = ({ title, message, action, onConfirm, onClose, testId }) => (
  <Sheet title={title} onClose={onClose} testId={testId}>
    <p className="bw-sheet-text">{message}</p>
    <div className="bw-sheet-buttons">
      <button type="button" className="bw-button bw-secondary" onClick={onClose}>Cancel</button>
      <button type="button" className="bw-button bw-danger-button" onClick={() => Promise.resolve(onConfirm()).then(onClose, (e) => toast.error(e?.message || 'Something went wrong'))} data-testid={`${testId}-ok`}>{action}</button>
    </div>
  </Sheet>
);

// Folders of a collection as a flat list of move / create targets.
const folderTargets = (items, depth, out) => {
  for (const i of [...(items || [])].sort(bySeq)) {
    if (isItemAFolder(i)) {
      out.push({ item: i, depth });
      folderTargets(i.items, depth + 1, out);
    }
  }
  return out;
};

const Destinations = ({ collections, value, onPick, exclude }) => (
  <div className="bw-choices" role="radiogroup" aria-label="Location">
    {collections.filter((c) => c.mountStatus === 'mounted').map((c) => (
      <React.Fragment key={c.uid}>
        <EnvChoice name={c.name} active={value.collectionUid === c.uid && !value.folderUid} onPick={() => onPick({ collectionUid: c.uid, folderUid: null })} />
        {folderTargets(c.items, 1, []).filter(({ item }) => item.uid !== exclude).map(({ item, depth }) => (
          <button key={item.uid} type="button" role="radio" aria-checked={value.folderUid === item.uid} className={`bw-choice${value.folderUid === item.uid ? ' bw-active' : ''}`} style={{ paddingLeft: 20 + depth * 20 }} onClick={() => onPick({ collectionUid: c.uid, folderUid: item.uid })}>
            <Icon name="folder" size={16} />
            <span className="bw-grow">{item.name}</span>
            {value.folderUid === item.uid ? <Icon name="check" width={2.25} /> : null}
          </button>
        ))}
      </React.Fragment>
    ))}
  </div>
);

export const MoveSheet = ({ item, collection, collections, onClose }) => {
  const dispatch = useDispatch();
  const [target, setTarget] = useState({ collectionUid: collection.uid, folderUid: null });
  const move = () => {
    const c = collections.find((x) => x.uid === target.collectionUid);
    const targetItem = target.folderUid ? folderTargets(c.items, 1, []).find((f) => f.item.uid === target.folderUid).item : c;
    return dispatch(handleMultipleCollectionItemsDrop({
      targetItem,
      draggedItems: [{ ...item, sourceCollectionUid: collection.uid }],
      dropType: 'inside',
      collectionUid: target.collectionUid
    })).then(() => {
      toast.success('Moved');
      onClose();
    }, (e) => toast.error(e?.message || 'Could not move'));
  };
  return (
    <Sheet title={`Move “${item.name}”`} tall onClose={onClose} testId="bw-phone-move" left={<TextButton onClick={onClose}>Cancel</TextButton>} right={<TextButton brand onClick={move} testId="bw-phone-move-ok">Move</TextButton>}>
      <Destinations collections={collections} value={target} onPick={setTarget} exclude={item.uid} />
    </Sheet>
  );
};

// -------------------------------------------------------- code generation

export const snippetFor = (item, collection, language) => {
  const resolved = resolveInheritedAuth(item, collection);
  const finalItem = { ...item, request: { ...(item.draft ? item.draft.request : item.request), auth: resolved.auth } };
  return generateSnippet({ language, item: finalItem, collection, shouldInterpolate: true });
};
const CURL = { name: 'Shell-curl', target: 'shell', client: 'curl' };
export const curlFor = (item, collection) => snippetFor(item, collection, CURL);

export const CodeSheet = ({ item, collection, onClose }) => {
  const languages = useMemo(() => getLanguages(), []);
  const [language, setLanguage] = useState(languages[0] || CURL);
  const [code, setCode] = useState('');
  useEffect(() => {
    let live = true;
    setCode('');
    snippetFor(item, collection, language).then((s) => live && setCode(s));
    return () => {
      live = false;
    };
  }, [item, collection, language]);
  return (
    <Sheet title="Generate code" tall onClose={onClose} testId="bw-phone-code" left={<TextButton onClick={onClose}>Close</TextButton>} right={<TextButton brand onClick={() => copyText(code)} disabled={!code}>Copy</TextButton>}>
      <div className="bw-pad-x">
        <label className="bw-select-field">
          <span className="bw-sr">Language</span>
          <select value={language.name} onChange={(e) => setLanguage(languages.find((l) => l.name === e.target.value))} data-testid="bw-phone-code-language">
            {languages.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
          </select>
          <Icon name="down" size={12} width={2.25} />
        </label>
        <pre className="bw-box bw-mono bw-code-block" data-testid="bw-phone-code-text">{code || 'Generating…'}</pre>
      </div>
    </Sheet>
  );
};

// ------------------------------------------------------------------ menus

export const RequestMenu = ({ item, collection, onClose, onAction }) => (
  <Sheet label="Request actions" onClose={onClose} testId="bw-phone-request-menu">
    <div className="bw-sheet-caption">
      <span className={methodClass(item.type === 'http-request' ? (item.draft || item).request?.method : 'GQL')}>{item.type === 'http-request' ? (item.draft || item).request?.method : 'GQL'}</span>
      <span className="bw-strong">{item.name}</span>
      <span className="bw-muted bw-small">{collection.name}</span>
    </div>
    <MenuRow icon="terminal" label="Copy as cURL" onClick={() => onAction('curl')} testId="bw-phone-action-curl" />
    <MenuRow icon="code" label="Generate code" hint="fetch, Python, Go…" onClick={() => onAction('code')} testId="bw-phone-action-code" />
    <MenuDivider />
    <MenuRow icon="copy" label="Clone" onClick={() => onAction('clone')} testId="bw-phone-action-clone" />
    <MenuRow icon="pencil" label="Rename" onClick={() => onAction('rename')} testId="bw-phone-action-rename" />
    <MenuRow icon="move" label="Move to…" onClick={() => onAction('move')} testId="bw-phone-action-move" />
    <MenuDivider />
    <MenuRow icon="run" label={`Run all in “${collection.name}”`} onClick={() => onAction('run')} testId="bw-phone-action-run" />
    <MenuRow icon="monitor" label="Open in full interface" onClick={() => onAction('full')} testId="bw-phone-full" />
    <MenuDivider />
    <MenuRow icon="trash" label="Delete" danger onClick={() => onAction('delete')} testId="bw-phone-action-delete" />
  </Sheet>
);

export const GroupMenu = ({ collection, folder, onClose, onAction }) => (
  <Sheet label={folder ? 'Folder actions' : 'Collection actions'} onClose={onClose} testId="bw-phone-group-menu">
    <div className="bw-sheet-caption">
      <Icon name={folder ? 'folder' : 'box'} size={16} />
      <span className="bw-strong">{folder ? folder.name : collection.name}</span>
      {folder ? <span className="bw-muted bw-small">{collection.name}</span> : null}
    </div>
    <MenuRow icon="plus" label="New request here" onClick={() => onAction('new-request')} testId="bw-phone-action-new-request" />
    <MenuRow icon="folder" label="New folder here" onClick={() => onAction('new-folder')} testId="bw-phone-action-new-folder" />
    <MenuRow icon="run" label={`Run all in “${folder ? folder.name : collection.name}”`} onClick={() => onAction('run')} testId="bw-phone-action-run" />
    {folder ? (
      <>
        <MenuDivider />
        <MenuRow icon="pencil" label="Rename" onClick={() => onAction('rename')} testId="bw-phone-action-rename" />
        <MenuRow icon="copy" label="Clone" onClick={() => onAction('clone')} testId="bw-phone-action-clone" />
        <MenuRow icon="trash" label="Delete" danger onClick={() => onAction('delete')} testId="bw-phone-action-delete" />
      </>
    ) : null}
    <MenuDivider />
    <MenuRow icon="monitor" label="Open in full interface" onClick={() => onAction('full')} />
  </Sheet>
);

export const WorkspaceMenu = ({ onClose, onFull }) => (
  <Sheet label="More" onClose={onClose} testId="bw-phone-workspace-menu">
    <MenuRow icon="monitor" label="Open in full interface" onClick={onFull} testId="bw-phone-full" />
  </Sheet>
);

const BINARY_LIMIT = 5 * 1024 * 1024;

export const saveAsExample = (dispatch, item, collection, name) => {
  const r = item.response;
  const contentType = getContentType(r.headers);
  const bodyType = getExampleBodyType(contentType, detectContentTypeFromBase64(r.dataBuffer));
  const content = bodyType === 'binary' ? r.dataBuffer : formatResponse(r.data, r.dataBuffer, bodyType);
  dispatch(addResponseExample({
    itemUid: item.uid,
    collectionUid: collection.uid,
    example: {
      uid: uuid(),
      name,
      description: '',
      status: String(r.status ?? ''),
      headers: Object.entries(r.headers || {}).map(([n, v]) => ({ name: n, value: Array.isArray(v) ? v.join(', ') : String(v), enabled: true })),
      body: { type: bodyType, content }
    }
  }));
  return dispatch(saveRequest(item.uid, collection.uid, true)).then(() => toast.success('Saved as example'));
};

export const ResponseMenu = ({ item, onClose, onAction }) => {
  const r = item.response || {};
  const canShare = typeof navigator.share === 'function';
  const canExample = item.type === 'http-request' && !r.error && !r.stream && (r.size || 0) < BINARY_LIMIT;
  return (
    <Sheet label="Response actions" onClose={onClose} testId="bw-phone-response-actions">
      <div className="bw-sheet-caption bw-muted bw-small">Response{r.status ? ` · ${r.status} ${r.statusText || ''}` : ''}</div>
      <MenuRow icon="copy" label="Copy body" onClick={() => onAction('copy')} disabled={!!r.error} testId="bw-phone-action-copy-body" />
      {canShare ? <MenuRow icon="share" label="Share…" hint="Messages, Mail…" onClick={() => onAction('share')} testId="bw-phone-action-share" /> : null}
      <MenuRow icon="bookmark" label="Save as example" hint="kept with this request" onClick={() => onAction('example')} disabled={!canExample} testId="bw-phone-action-example" />
      <MenuRow icon="download" label="Download body" onClick={() => onAction('download')} disabled={!!r.error} testId="bw-phone-action-download" />
      <MenuDivider />
      <MenuRow icon="terminal" label="Copy request as cURL" onClick={() => onAction('curl')} />
      <MenuRow icon="monitor" label="Open in full interface" onClick={() => onAction('full')} />
    </Sheet>
  );
};

// ----------------------------------------------------------------- create

const TYPES = [['http-request', 'HTTP'], ['graphql-request', 'GraphQL'], ['grpc-request', 'gRPC'], ['ws-request', 'WebSocket']];

export const NewSheet = ({ collections, initial, onClose }) => {
  const dispatch = useDispatch();
  const [kind, setKind] = useState(initial?.kind || 'request');
  const [type, setType] = useState('http-request');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState('GET');
  const [curl, setCurl] = useState(null);
  const firstMounted = collections.find((c) => c.mountStatus === 'mounted');
  const [where, setWhere] = useState({ collectionUid: initial?.collectionUid || firstMounted?.uid, folderUid: initial?.folderUid || null });
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const collection = collections.find((c) => c.uid === where.collectionUid);
  const folder = collection && where.folderUid ? folderTargets(collection.items, 1, []).find((f) => f.item.uid === where.folderUid)?.item : null;

  const create = () => {
    if (!name.trim() || !collection || busy) return;
    const base = { collectionUid: collection.uid, itemUid: where.folderUid };
    const filename = sanitizeName(name.trim());
    let run;
    if (kind === 'folder') {
      run = dispatch(newFolder(name.trim(), filename, collection.uid, where.folderUid));
    } else if (curl !== null) {
      const parsed = getRequestFromCurlCommand(curl, type === 'graphql-request' ? 'graphql-request' : 'http-request');
      if (!parsed) {
        toast.error('This does not look like a cURL command');
        return;
      }
      run = dispatch(newHttpRequest({
        ...base,
        requestName: name.trim(),
        filename,
        requestType: type === 'graphql-request' ? 'graphql-request' : 'http-request',
        requestUrl: parsed.url,
        requestMethod: parsed.method,
        headers: parsed.headers,
        body: parsed.body,
        auth: parsed.auth,
        settings: { encodeUrl: false, forwardAuthorizationHeader: false }
      }));
    } else if (type === 'grpc-request') {
      run = dispatch(newGrpcRequest({ ...base, requestName: name.trim(), filename, requestUrl: url }));
    } else if (type === 'ws-request') {
      run = dispatch(newWsRequest({ ...base, requestName: name.trim(), filename, requestUrl: url, requestMethod: 'ws' }));
    } else {
      run = dispatch(newHttpRequest({ ...base, requestName: name.trim(), filename, requestType: type, requestUrl: url, requestMethod: type === 'graphql-request' ? 'POST' : method }));
    }
    setBusy(true);
    Promise.resolve(run).then(onClose, (e) => {
      setBusy(false);
      toast.error(e?.message || 'Could not create it');
    });
  };

  if (picking) {
    return (
      <Sheet title="Location" tall onClose={() => setPicking(false)} left={<TextButton onClick={() => setPicking(false)}>Back</TextButton>}>
        <Destinations collections={collections} value={where} onPick={(w) => { setWhere(w); setPicking(false); }} />
      </Sheet>
    );
  }

  return (
    <Sheet
      title="New"
      tall
      onClose={onClose}
      testId="bw-phone-new"
      left={<TextButton onClick={onClose}>Cancel</TextButton>}
      right={<TextButton brand onClick={create} disabled={!name.trim() || !collection || busy} testId="bw-phone-new-create">Create</TextButton>}
    >
      <nav className="bw-tabs" aria-label="What to create">
        {[['request', 'Request'], ['folder', 'Folder']].map(([k, label]) => (
          <button key={k} type="button" className={`bw-tab${kind === k ? ' bw-active' : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)} data-testid={`bw-phone-new-${k}`}>{label}</button>
        ))}
      </nav>
      {!collection ? <Empty>Open a collection in the list first.</Empty> : (
        <form className="bw-form" onSubmit={(e) => { e.preventDefault(); create(); }}>
          {kind === 'request' ? (
            <div className="bw-field">
              <span className="bw-label">Type</span>
              <div className="bw-type-grid" role="radiogroup" aria-label="Request type">
                {TYPES.map(([t, label]) => (
                  <button key={t} type="button" role="radio" aria-checked={type === t} className={`bw-type${type === t ? ' bw-active' : ''}`} onClick={() => setType(t)}>{label}</button>
                ))}
              </div>
            </div>
          ) : null}
          <label className="bw-field">
            <span className="bw-label">Name</span>
            <input className="bw-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'folder' ? 'Folder name' : 'Request name'} data-testid="bw-phone-new-name" />
          </label>
          <div className="bw-field">
            <span className="bw-label">Location</span>
            <button type="button" className="bw-input bw-select-like" onClick={() => setPicking(true)} data-testid="bw-phone-new-location">
              <span className="bw-grow">{collection.name}{folder ? <><span className="bw-subtle"> / </span>{folder.name}</> : null}</span>
              <Icon name="down" size={12} width={2.25} />
            </button>
          </div>
          {kind === 'request' && (type === 'http-request' || type === 'graphql-request') ? (
            <div className="bw-field">
              <span className="bw-between">
                <span className="bw-label">{curl !== null ? 'cURL command' : 'URL'}</span>
                <button type="button" className="bw-text-button bw-link-text bw-small" onClick={() => setCurl(curl === null ? '' : null)} data-testid="bw-phone-new-curl-toggle">
                  {curl !== null ? 'Enter a URL instead' : 'Paste a cURL command instead'}
                </button>
              </span>
              {curl !== null ? (
                <textarea className="bw-textarea bw-mono" rows={5} value={curl} onChange={(e) => setCurl(e.target.value)} placeholder="curl https://…" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid="bw-phone-new-curl" />
              ) : (
                <span className="bw-input bw-url-input">
                  {type === 'http-request' ? (
                    <label className={`bw-method-select ${methodClass(method)}`}>
                      <span className="bw-sr">Method</span>
                      <select value={method} onChange={(e) => setMethod(e.target.value)} data-testid="bw-phone-new-method">
                        {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                      <span aria-hidden="true">{method}</span>
                      <Icon name="down" size={11} width={2.5} />
                    </label>
                  ) : <span className={methodClass('POST')}>POST</span>}
                  <input aria-label="URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid="bw-phone-new-url" />
                </span>
              )}
            </div>
          ) : null}
          {kind === 'request' && (type === 'grpc-request' || type === 'ws-request') ? (
            <label className="bw-field">
              <span className="bw-label">URL</span>
              <input className="bw-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={type === 'ws-request' ? 'wss://' : 'grpc://'} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
              <span className="bw-hint-text">These requests open in the full interface.</span>
            </label>
          ) : null}
        </form>
      )}
    </Sheet>
  );
};

// Item operations used by both the request and the folder menus.
export const itemOps = (dispatch, collection) => ({
  clone: (item, name) => dispatch(cloneItem(name, sanitizeName(name), item.uid, collection.uid)),
  rename: (item, name) => {
    const save = isItemAFolder(item) ? saveFolderRoot(collection.uid, item.uid, true) : saveRequest(item.uid, collection.uid, true);
    const first = item.draft ? dispatch(save) : Promise.resolve();
    return first.then(() => dispatch(renameItem({ newName: name, newFilename: sanitizeName(name), itemUid: item.uid, collectionUid: collection.uid })));
  },
  remove: (item) => dispatch(deleteItem(item.uid, collection.uid)).then(() => {
    const uids = [];
    const walk = (i) => {
      uids.push(i.uid);
      (i.items || []).forEach(walk);
    };
    walk(item);
    return dispatch(closeTabs({ tabUids: uids }));
  })
});
