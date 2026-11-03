/*
 * Phone mode: a layout for phones built from upstream's own store, actions and
 * components. scripts/fetch-upstream.sh copies this directory into the
 * renderer source as src/bruno-web-phone, and patches/0001-phone-mode.patch
 * renders it from pages/Bruno instead of the desktop layout on phones.
 *
 * The current request is upstream's active tab, and edits go through
 * upstream's draft actions, so switching to the full interface and back keeps
 * the same request, draft, environment and response.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { addTab } from 'providers/ReduxStore/slices/tabs';
import { requestUrlChanged } from 'providers/ReduxStore/slices/collections';
import { sendRequest, saveRequest, mountCollection } from 'providers/ReduxStore/slices/collections/actions';
import { findItemInCollection, getWorkspaceCollections, isItemAFolder, isItemARequest } from 'utils/collections';
import ResponsePane from 'components/ResponsePane';
import HttpRequestPane from 'components/RequestPane/HttpRequestPane';
import EnvironmentSelector from 'components/Environments/EnvironmentSelector';
import './phone.css';

const QUERY = '(max-width: 760px) and (pointer: coarse)';
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
  useEffect(() => {
    document.documentElement.classList.toggle('bw-phone-mode', active);
    // The full interface's drawer (web/mobile.js) must not stay open underneath.
    if (active) document.documentElement.classList.remove('bw-drawer-open');
  }, [active]);
  return { eligible, active, showFull: () => choose('full'), showPhone: () => choose('phone') };
};

export const PhoneModeSwitch = ({ phone }) => (
  <button type="button" className="bw-phone-switch" data-testid="bw-phone-switch" onClick={phone.showPhone}>
    手机视图
  </button>
);

const bySeq = (a, b) => (a.seq ?? 0) - (b.seq ?? 0) || String(a.name).localeCompare(String(b.name));

const Tree = ({ items, depth, onOpen }) => {
  const [open, setOpen] = useState({});
  return [...(items || [])].sort(bySeq).map((item) => {
    if (isItemAFolder(item)) {
      const expanded = !!open[item.uid];
      return (
        <div key={item.uid}>
          <button type="button" className="bw-phone-row folder" style={{ paddingLeft: 16 + depth * 16 }} onClick={() => setOpen({ ...open, [item.uid]: !expanded })}>
            <span className="chevron">{expanded ? '▾' : '▸'}</span>
            {item.name}
          </button>
          {expanded && <Tree items={item.items} depth={depth + 1} onOpen={onOpen} />}
        </div>
      );
    }
    if (!isItemARequest(item)) return null;
    const method = item.request?.method || (item.type === 'graphql-request' ? 'GQL' : item.type.replace('-request', '').toUpperCase());
    return (
      <button key={item.uid} type="button" className="bw-phone-row request" style={{ paddingLeft: 16 + depth * 16 }} onClick={() => onOpen(item)} data-testid="bw-phone-request">
        <span className={`method ${String(method).toLowerCase()}`}>{method}</span>
        <span className="name">{item.name}</span>
        {item.draft ? <span className="draft" title="未保存">●</span> : null}
      </button>
    );
  });
};

const ListScreen = ({ collections, onOpen }) => {
  const dispatch = useDispatch();
  const [open, setOpen] = useState({});
  const toggle = (c) => {
    if (c.mountStatus !== 'mounted' && c.mountStatus !== 'mounting') {
      dispatch(mountCollection({ collectionUid: c.uid, collectionPathname: c.pathname, brunoConfig: c.brunoConfig }));
    }
    setOpen({ ...open, [c.uid]: !open[c.uid] });
  };
  return (
    <div className="bw-phone-scroll">
      {collections.length === 0 ? <p className="bw-phone-empty">这个工作区还没有集合。请切到完整界面打开或导入集合。</p> : null}
      {collections.map((c) => (
        <div key={c.uid}>
          <button type="button" className="bw-phone-row collection" onClick={() => toggle(c)} data-testid="bw-phone-collection">
            <span className="chevron">{open[c.uid] ? '▾' : '▸'}</span>
            {c.name}
          </button>
          {open[c.uid] ? (c.mountStatus === 'mounted' ? <Tree items={c.items} depth={1} onOpen={(item) => onOpen(c, item)} /> : <p className="bw-phone-empty">加载中…</p>) : null}
        </div>
      ))}
    </div>
  );
};

const statusText = (item) => {
  if (['queued', 'sending'].includes(item.requestState)) return '发送中…';
  const r = item.response;
  if (!r) return '';
  if (r.error) return '出错';
  return `${r.status ?? ''} ${r.statusText ?? ''} · ${r.duration ?? '-'} ms`.trim();
};

export default function BrunoWebPhone({ phone }) {
  const dispatch = useDispatch();
  const allCollections = useSelector((state) => state.collections.collections);
  const workspaces = useSelector((state) => state.workspaces.workspaces);
  const activeWorkspaceUid = useSelector((state) => state.workspaces.activeWorkspaceUid);
  const tabs = useSelector((state) => state.tabs.tabs);
  const activeTabUid = useSelector((state) => state.tabs.activeTabUid);

  const activeWorkspace = workspaces.find((w) => w.uid === activeWorkspaceUid);
  const collections = useMemo(
    () => getWorkspaceCollections({ collections: allCollections, workspaces, activeWorkspace }),
    [allCollections, workspaces, activeWorkspace]
  );

  const tab = tabs.find((t) => t.uid === activeTabUid);
  const collection = tab ? allCollections.find((c) => c.uid === tab.collectionUid) : null;
  const found = collection && tab ? findItemInCollection(collection, tab.uid) : null;
  const item = found && isItemARequest(found) ? found : null;

  const [screen, setScreen] = useState(item ? 'request' : 'list');
  const current = item ? screen : 'list';

  const open = (c, it) => {
    dispatch(addTab({ uid: it.uid, collectionUid: c.uid, requestPaneTab: 'params', preview: false }));
    setScreen('request');
  };

  const request = item ? (item.draft || item).request : null;
  const send = () => {
    Promise.resolve(dispatch(sendRequest(item, collection.uid))).catch(() => {});
    setScreen('response');
  };

  return (
    <div className="bw-phone" data-testid="bw-phone">
      <header className="bw-phone-header">
        {current !== 'list' ? (
          <button type="button" className="bw-phone-back" onClick={() => setScreen(current === 'request' ? 'list' : 'request')} aria-label="返回">‹</button>
        ) : null}
        <div className="bw-phone-title">{current === 'list' ? (activeWorkspace?.name || 'Bruno') : item.name}</div>
        {current !== 'list' && item.draft ? (
          <button type="button" className="bw-phone-action" onClick={() => dispatch(saveRequest(item.uid, collection.uid))} data-testid="bw-phone-save">保存</button>
        ) : null}
        <button type="button" className="bw-phone-action subtle" onClick={phone.showFull} data-testid="bw-phone-full">完整界面</button>
      </header>

      {current === 'list' ? <ListScreen collections={collections} onOpen={open} /> : null}

      {current === 'request' ? (
        <div className="bw-phone-scroll">
          <div className="bw-phone-env"><EnvironmentSelector collection={collection} /></div>
          <div className="bw-phone-url">
            <span className={`method ${String(request.method).toLowerCase()}`}>{request.method}</span>
            <textarea
              data-testid="bw-phone-url"
              value={request.url}
              rows={3}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => dispatch(requestUrlChanged({ itemUid: item.uid, collectionUid: collection.uid, url: e.target.value }))}
            />
          </div>
          <button type="button" className="bw-phone-send" onClick={send} data-testid="bw-phone-send">发送</button>
          {item.response || item.requestState ? (
            <button type="button" className="bw-phone-row" onClick={() => setScreen('response')} data-testid="bw-phone-last-response">
              上次响应：{statusText(item)}
            </button>
          ) : null}
          <button type="button" className="bw-phone-row" onClick={() => setScreen('edit')} data-testid="bw-phone-edit">编辑参数、请求头、请求体…</button>
        </div>
      ) : null}

      {current === 'edit' ? (
        <div className="bw-phone-pane"><HttpRequestPane item={item} collection={collection} /></div>
      ) : null}

      {current === 'response' ? (
        <div className="bw-phone-pane" data-testid="bw-phone-response">
          <ResponsePane item={item} collection={collection} response={item.response} />
        </div>
      ) : null}
    </div>
  );
}
