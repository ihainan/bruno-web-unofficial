/*
 * Phone mode: a request manager for phones built from upstream's own store,
 * actions and components. scripts/fetch-upstream.sh copies this directory into
 * the renderer source as src/bruno-web-phone, and patches/0001-phone-mode.patch
 * renders it from pages/Bruno instead of the desktop layout on phones.
 *
 * The current request is upstream's active tab, and edits go through
 * upstream's draft actions, so switching to the full interface and back keeps
 * the same request, draft, environment and response.
 *
 * Everything imported from upstream here is a contract the phone tests in
 * test/e2e/web.spec.js ("on a phone") check after every upstream upgrade.
 */
'use no memo'; // React Compiler mis-memoizes optional chains here (env?.variables read as env.variables).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import toast from 'react-hot-toast';
import { addTab, makeTabPermanent, updateRequestPaneTab, updateResponsePaneTab } from 'providers/ReduxStore/slices/tabs';
import { sendRequest, saveRequest, cancelRequest, mountCollection } from 'providers/ReduxStore/slices/collections/actions';
import {
  findItemInCollection,
  getAllVariables,
  getGlobalEnvironmentVariables,
  getGlobalEnvironmentVariablesMasked,
  getWorkspaceCollections,
  isItemARequest
} from 'utils/collections';
import { getContentType } from 'utils/common';
import { getDefaultResponseFormat } from 'utils/response';
import { Themed, ThemedButton } from './theme';
import { ListScreen, hasDraft, readRecent, rememberRecent } from './list';
import { RequestScreen } from './request';
import { ResponseScreen, bodyText } from './response';
import { RunnerScreen } from './runner';
import {
  EnvSheet,
  VarPeek,
  PromptSheet,
  ConfirmSheet,
  MoveSheet,
  CodeSheet,
  RequestMenu,
  GroupMenu,
  WorkspaceMenu,
  ResponseMenu,
  NewSheet,
  copyText,
  curlFor,
  itemOps,
  saveAsExample
} from './sheets';
import './phone.css';

// A phone in either orientation: narrow, or (in landscape) short. Tablets are
// neither and keep the full interface.
const QUERY = '(pointer: coarse) and (max-width: 760px), (pointer: coarse) and (max-height: 500px)';
const KEY = 'bruno-web-phone-mode';

const readChoice = () => {
  try {
    return sessionStorage.getItem(KEY);
  } catch (e) {
    return null;
  }
};

export const usePhoneMode = () => {
  const [eligible, setEligible] = useState(() => window.matchMedia(QUERY).matches);
  const [choice, setChoice] = useState(readChoice);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = () => setEligible(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const choose = (value) => {
    try {
      sessionStorage.setItem(KEY, value);
    } catch (e) {
      // The choice then lasts until the page reloads.
    }
    setChoice(value);
  };
  const active = eligible && choice !== 'full';
  // iOS lays the keyboard over the page instead of shrinking it: follow the
  // visible part, so what is being edited (and the symbol keys) stays above
  // the keyboard. phone.css reads these.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return undefined;
    const root = document.documentElement;
    const update = () => {
      root.style.setProperty('--bw-vv-h', `${vv.height}px`);
      root.style.setProperty('--bw-vv-top', `${vv.offsetTop}px`);
      root.classList.toggle('bw-kb-open', window.innerHeight - vv.height > 120);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty('--bw-vv-h');
      root.style.removeProperty('--bw-vv-top');
      root.classList.remove('bw-kb-open');
    };
  }, [active]);
  useEffect(() => {
    document.documentElement.classList.toggle('bw-phone-mode', active);
    // The full interface's drawer (web/mobile.js) must not stay open underneath.
    if (active) document.documentElement.classList.remove('bw-drawer-open');
  }, [active]);
  return { eligible, active, showFull: () => choose('full'), showPhone: () => choose('phone') };
};

export const PhoneModeSwitch = ({ phone }) => (
  <ThemedButton type="button" className="bw-phone-switch" data-testid="bw-phone-switch" onClick={phone.showPhone}>
    Phone view
  </ThemedButton>
);

const formatOf = (response) => {
  try {
    return getDefaultResponseFormat(getContentType(response.headers)).format || 'raw';
  } catch (e) {
    return 'raw';
  }
};

export default function BrunoWebPhone({ phone }) {
  const dispatch = useDispatch();
  const allCollections = useSelector((state) => state.collections.collections);
  const workspaces = useSelector((state) => state.workspaces.workspaces);
  const activeWorkspaceUid = useSelector((state) => state.workspaces.activeWorkspaceUid);
  const tabs = useSelector((state) => state.tabs.tabs);
  const activeTabUid = useSelector((state) => state.tabs.activeTabUid);
  const { globalEnvironments, activeGlobalEnvironmentUid, globalEnvironmentDraft } = useSelector((state) => state.globalEnvironments);

  const activeWorkspace = workspaces.find((w) => w.uid === activeWorkspaceUid);
  const collections = useMemo(
    () => getWorkspaceCollections({ collections: allCollections, workspaces, activeWorkspace }),
    [allCollections, workspaces, activeWorkspace]
  );

  const tab = tabs.find((t) => t.uid === activeTabUid);
  const tabCollection = tab ? allCollections.find((c) => c.uid === tab.collectionUid) : null;
  // As upstream's RequestTabPanel does, give the editors the selected global
  // environment (variable highlighting, autocomplete and values use it).
  const collection = useMemo(() => tabCollection && {
    ...tabCollection,
    globalEnvironmentVariables: getGlobalEnvironmentVariables({ globalEnvironments, activeGlobalEnvironmentUid }),
    globalEnvSecrets: getGlobalEnvironmentVariablesMasked({ globalEnvironments, activeGlobalEnvironmentUid }),
    globalEnvironments,
    activeGlobalEnvironmentUid
  }, [tabCollection, globalEnvironments, activeGlobalEnvironmentUid]);
  const found = collection && tab ? findItemInCollection(collection, tab.uid) : null;
  const item = found && isItemARequest(found) ? found : null;
  const variables = useMemo(() => (collection && item ? getAllVariables(collection, item) : {}), [collection, item]);

  const [screen, setScreenState] = useState(item ? 'request' : 'list');
  // After a reload the open request arrives once its collection has loaded:
  // show it, unless the user has already gone somewhere.
  const moved = useRef(false);
  const setScreen = (s) => {
    moved.current = true;
    setScreenState(s);
  };
  useEffect(() => {
    if (!moved.current && item && screen === 'list') setScreenState('request');
  }, [item, screen]);
  const tabMount = tabCollection ? tabCollection.mountStatus : null;
  useEffect(() => {
    if (!tabCollection || tabMount === 'mounted' || tabMount === 'mounting') return;
    Promise.resolve(dispatch(mountCollection({ collectionUid: tabCollection.uid, collectionPathname: tabCollection.pathname, brunoConfig: tabCollection.brunoConfig }))).catch(() => {});
  }, [tabCollection && tabCollection.uid, tabMount]);
  const [runner, setRunner] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [recent, setRecent] = useState(readRecent);
  const closeSheet = useCallback(() => setSheet(null), []);
  const runnerCollection = runner ? allCollections.find((c) => c.uid === runner.collectionUid) : null;
  const current = screen === 'runner' ? (runnerCollection ? 'runner' : 'list') : !item ? 'list' : screen;

  // A request opened elsewhere (a new or cloned request, once its file is
  // loaded) becomes the current one.
  const lastTab = useRef(activeTabUid);
  useEffect(() => {
    if (!item || activeTabUid === lastTab.current) return;
    lastTab.current = activeTabUid;
    setScreen('request');
    setRecent(rememberRecent(collection.uid, item.uid));
  }, [activeTabUid, item, collection]);

  // Like a click in the desktop sidebar, opening a request replaces the
  // previous preview tab; editing it keeps the tab, as on the desktop.
  useEffect(() => {
    if (tab && tab.preview && item && item.draft) dispatch(makeTabPermanent({ uid: tab.uid }));
  }, [tab, item, dispatch]);

  // Closing the browser tab asks first while anything is unsaved (web/bridge.js
  // reads this; the desktop layout's tab bar, which marks the same drafts, is
  // not rendered here).
  const unsaved = !!globalEnvironmentDraft || allCollections.some((c) => c.draft || c.environmentsDraft || hasDraft(c.items));
  useEffect(() => {
    document.documentElement.classList.toggle('bw-has-draft', unsaved);
    return () => document.documentElement.classList.remove('bw-has-draft');
  }, [unsaved]);

  const open = (c, it) => {
    lastTab.current = it.uid;
    dispatch(addTab({ uid: it.uid, collectionUid: c.uid, type: 'request', requestPaneTab: 'params', preview: true }));
    setRecent(rememberRecent(c.uid, it.uid));
    setScreen('request');
  };

  const inFlight = !!item && ['queued', 'sending'].includes(item.requestState);
  // Show the response screen once the request is under way: sendRequest first
  // asks for any {{?prompt}} variables (cancelling resolves it with nothing
  // sent), then gives the item a new requestUid. It does not settle at all
  // for some failures, so its promise only ends the wait.
  const [waiting, setWaiting] = useState(null);
  const send = () => {
    setWaiting({ itemUid: item.uid, requestUid: item.requestUid });
    Promise.resolve(dispatch(sendRequest(item, collection.uid)))
      .catch(() => {})
      .finally(() => setWaiting(null));
  };
  useEffect(() => {
    if (!waiting || !item || item.uid !== waiting.itemUid || item.requestUid === waiting.requestUid) return;
    setWaiting(null);
    setScreen('response');
  }, [waiting, item]);

  const envName = collection ? (collection.environments || []).find((e) => e.uid === collection.activeEnvironmentUid)?.name : null;
  const runnerEnvName = runnerCollection ? (runnerCollection.environments || []).find((e) => e.uid === runnerCollection.activeEnvironmentUid)?.name : null;
  const startRunner = (c, folderUid) => {
    setSheet(null);
    setRunner({ collectionUid: c.uid, folderUid: folderUid || null });
    setScreen('runner');
  };

  const copyCurl = () => curlFor(item, collection).then((s) => copyText(s, 'Copied as cURL'));

  const onRequestAction = (action) => {
    const ops = itemOps(dispatch, collection);
    switch (action) {
      case 'curl': setSheet(null); return copyCurl();
      case 'code': return setSheet({ type: 'code' });
      case 'clone': return setSheet({ type: 'prompt', title: 'Clone request', label: 'Name', initial: `${item.name} copy`, action: 'Clone', run: (name) => ops.clone(item, name), testId: 'bw-phone-clone' });
      case 'rename': return setSheet({ type: 'prompt', title: 'Rename request', label: 'Name', initial: item.name, action: 'Rename', run: (name) => ops.rename(item, name), testId: 'bw-phone-rename' });
      case 'move': return setSheet({ type: 'move', item, collection: tabCollection });
      case 'run': return startRunner(tabCollection, null);
      case 'full': return phone.showFull();
      case 'delete': return setSheet({ type: 'confirm', title: 'Delete request', message: `Delete “${item.name}”? This removes its file.`, action: 'Delete', run: () => ops.remove(item).then(() => setScreen('list')), testId: 'bw-phone-delete' });
      default: return null;
    }
  };

  const onGroupAction = (c, folder) => (action) => {
    const ops = itemOps(dispatch, c);
    switch (action) {
      case 'new-request': return setSheet({ type: 'new', initial: { kind: 'request', collectionUid: c.uid, folderUid: folder?.uid || null } });
      case 'new-folder': return setSheet({ type: 'new', initial: { kind: 'folder', collectionUid: c.uid, folderUid: folder?.uid || null } });
      case 'run': return startRunner(c, folder?.uid);
      case 'rename': return setSheet({ type: 'prompt', title: 'Rename folder', label: 'Name', initial: folder.name, action: 'Rename', run: (name) => ops.rename(folder, name), testId: 'bw-phone-rename' });
      case 'clone': return setSheet({ type: 'prompt', title: 'Clone folder', label: 'Name', initial: `${folder.name} copy`, action: 'Clone', run: (name) => ops.clone(folder, name), testId: 'bw-phone-clone' });
      case 'delete': return setSheet({ type: 'confirm', title: 'Delete folder', message: `Delete “${folder.name}” and everything in it?`, action: 'Delete', run: () => ops.remove(folder), testId: 'bw-phone-delete' });
      case 'full': return phone.showFull();
      default: return null;
    }
  };

  const onResponseAction = (action) => {
    const r = item.response;
    switch (action) {
      case 'copy': setSheet(null); return copyText(bodyText(r, formatOf(r)), 'Copied the body');
      case 'share':
        setSheet(null);
        return navigator.share({ title: item.name, text: bodyText(r, formatOf(r)) }).catch((e) => {
          if (e && e.name !== 'AbortError') toast.error('Could not share');
        });
      case 'example': return setSheet({ type: 'prompt', title: 'Save as example', label: 'Example name', initial: `${item.name} ${r.status || ''}`.trim(), action: 'Save', run: (name) => saveAsExample(dispatch, item, collection, name), testId: 'bw-phone-example' });
      case 'download':
        setSheet(null);
        return window.ipcRenderer.invoke('renderer:save-response-to-file', r, item.requestSent?.url, item.pathname).catch(() => toast.error('Could not save the body'));
      case 'curl': setSheet(null); return copyCurl();
      case 'full': return phone.showFull();
      default: return null;
    }
  };

  const peek = (name, anchor) => setSheet({ type: 'var', name, anchor });

  return (
    <Themed className="bw-phone" data-testid="bw-phone">
      {/* Kept while a request is open, so going back finds the list as it was
          (open folders, search, scroll position). */}
      <ListScreen
        collections={collections}
        workspaceName={activeWorkspace?.name || 'Bruno'}
        recent={recent}
        onOpen={open}
        onNew={() => setSheet({ type: 'new', initial: null })}
        onMenu={(c, folder) => setSheet({ type: 'group', collection: c, folder })}
        onWorkspaceMenu={() => setSheet({ type: 'workspace' })}
        hidden={current !== 'list'}
      />

      {current === 'request' ? (
        <RequestScreen
          item={item}
          collection={collection}
          paneTab={tab.requestPaneTab}
          setPaneTab={(t) => dispatch(updateRequestPaneTab({ uid: tab.uid, requestPaneTab: t }))}
          variables={variables}
          envName={envName}
          busy={!!waiting || inFlight}
          onBack={() => setScreen('list')}
          onSend={send}
          onSave={() => dispatch(saveRequest(item.uid, collection.uid))}
          onMenu={() => setSheet({ type: 'request' })}
          onEnv={() => setSheet({ type: 'env' })}
          onVariable={peek}
          onResponse={() => setScreen('response')}
          onFull={phone.showFull}
        />
      ) : null}

      {current === 'response' ? (
        <ResponseScreen
          item={item}
          collection={collection}
          paneTab={tab.responsePaneTab}
          setPaneTab={(t) => dispatch(updateResponsePaneTab({ uid: tab.uid, responsePaneTab: t }))}
          inFlight={inFlight}
          onBack={() => setScreen('request')}
          onSend={send}
          onCancel={() => dispatch(cancelRequest(item.cancelTokenUid, item, collection))}
          onMenu={() => setSheet({ type: 'response' })}
          onCopyCurl={copyCurl}
        />
      ) : null}

      {current === 'runner' ? (
        <RunnerScreen
          collection={runnerCollection}
          folderUid={runner.folderUid}
          envName={runnerEnvName}
          onBack={() => setScreen('list')}
          onEnv={() => setSheet({ type: 'env', collectionUid: runnerCollection.uid })}
        />
      ) : null}

      {sheet?.type === 'env' && (sheet.collectionUid ? allCollections.find((c) => c.uid === sheet.collectionUid) : collection) ? (
        <EnvSheet collection={sheet.collectionUid ? allCollections.find((c) => c.uid === sheet.collectionUid) : collection} onClose={closeSheet} />
      ) : null}
      {sheet?.type === 'var' && item ? (
        <VarPeek name={sheet.name} anchor={sheet.anchor} collection={collection} item={item} onClose={closeSheet} onOpenEnv={() => setSheet({ type: 'env' })} />
      ) : null}
      {sheet?.type === 'request' && item ? <RequestMenu item={item} collection={collection} onClose={closeSheet} onAction={onRequestAction} /> : null}
      {sheet?.type === 'response' && item ? <ResponseMenu item={item} onClose={closeSheet} onAction={onResponseAction} /> : null}
      {sheet?.type === 'group' ? <GroupMenu collection={sheet.collection} folder={sheet.folder} onClose={closeSheet} onAction={onGroupAction(sheet.collection, sheet.folder)} /> : null}
      {sheet?.type === 'workspace' ? <WorkspaceMenu onClose={closeSheet} onFull={phone.showFull} /> : null}
      {sheet?.type === 'code' && item ? <CodeSheet item={item} collection={collection} onClose={closeSheet} /> : null}
      {sheet?.type === 'move' ? <MoveSheet item={sheet.item} collection={sheet.collection} collections={collections} onClose={closeSheet} /> : null}
      {sheet?.type === 'new' ? <NewSheet collections={collections} initial={sheet.initial} onClose={closeSheet} /> : null}
      {sheet?.type === 'prompt' ? (
        <PromptSheet title={sheet.title} label={sheet.label} initial={sheet.initial} action={sheet.action} onSubmit={sheet.run} onClose={closeSheet} testId={sheet.testId} />
      ) : null}
      {sheet?.type === 'confirm' ? (
        <ConfirmSheet title={sheet.title} message={sheet.message} action={sheet.action} onConfirm={sheet.run} onClose={closeSheet} testId={sheet.testId} />
      ) : null}
    </Themed>
  );
}
