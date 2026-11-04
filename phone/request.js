/*
 * The request screen: environment, method and URL, the request's tabs, and a
 * bottom bar with the last response and Send.
 */
'use no memo'; // React Compiler mis-memoizes optional chains here (env?.variables read as env.variables).
import React, { useState } from 'react';
import { useDispatch } from 'react-redux';
import { requestUrlChanged, updateRequestMethod } from 'providers/ReduxStore/slices/collections';
import RequestNotLoaded from 'components/RequestTabPanel/RequestNotLoaded';
import RequestIsLoading from 'components/RequestTabPanel/RequestIsLoading';
import { formatSize } from 'utils/common';
import { Header, IconButton, Icon, MethodLabel, Tabs, VarText, Empty, methodClass } from './ui';
import { RequestEditor, requestOf, requestTabs } from './editors';
import { methodOf, statusTone } from './list';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'TRACE', 'CONNECT'];

// The URL shows its variables coloured (tap one to see its value) and turns
// into a text field when tapped anywhere else.
const UrlBox = ({ item, collection, variables, onVariable }) => {
  const dispatch = useDispatch();
  const [editing, setEditing] = useState(false);
  const request = requestOf(item);
  const method = request.method || 'GET';
  const isHttp = item.type === 'http-request';
  return (
    <div className={`bw-url${editing ? ' bw-editing' : ''}`}>
      {isHttp ? (
        <label className={`bw-method-select ${methodClass(method)}`}>
          <span className="bw-sr">Method</span>
          <select
            value={method}
            onChange={(e) => dispatch(updateRequestMethod({ method: e.target.value, itemUid: item.uid, collectionUid: collection.uid }))}
            data-testid="bw-phone-method"
          >
            {(METHODS.includes(method) ? METHODS : [method, ...METHODS]).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <span aria-hidden="true">{method}</span>
          <Icon name="down" size={11} width={2.5} />
        </label>
      ) : (
        <span className={methodClass(methodOf(item))}>{methodOf(item)}</span>
      )}
      {editing ? (
        <textarea
          data-testid="bw-phone-url"
          aria-label="URL"
          autoFocus
          value={request.url || ''}
          rows={3}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="Enter URL"
          onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
          onBlur={() => setEditing(false)}
          onChange={(e) => dispatch(requestUrlChanged({ itemUid: item.uid, collectionUid: collection.uid, url: e.target.value.replace(/\n/g, '') }))}
        />
      ) : (
        <div className="bw-url-text" role="textbox" tabIndex={0} aria-label="URL" onClick={() => setEditing(true)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setEditing(true)} data-testid="bw-phone-url-view">
          <VarText text={request.url} variables={variables} onVariable={onVariable} placeholder="Enter URL" />
        </div>
      )}
    </div>
  );
};

export const LastResponse = ({ item, onOpen }) => {
  const r = item.response;
  if (!r && !item.requestState) return null;
  return (
    <button type="button" className="bw-last" onClick={onOpen} data-testid="bw-phone-last-response">
      <span className="bw-muted">Last response</span>
      {['queued', 'sending'].includes(item.requestState) ? <span>Sending…</span> : null}
      {item.requestState !== 'queued' && item.requestState !== 'sending' && r ? (
        r.error || r.isError ? <span className="bw-danger bw-strong">Error</span> : (
          <>
            <span className={`bw-${statusTone(r.status)} bw-strong`}>{r.status} {r.statusText}</span>
            <span className="bw-muted">{r.duration} ms · {formatSize(r.size || 0)}</span>
          </>
        )
      ) : null}
      <span className="bw-grow" />
      <Icon name="right" size={16} width={2} />
    </button>
  );
};

const trailOf = (collection, item) => {
  const names = [collection.name];
  const walk = (items, path) => {
    for (const i of items || []) {
      if (i.uid === item.uid) return path;
      if (i.items) {
        const found = walk(i.items, [...path, i.name]);
        if (found) return found;
      }
    }
    return null;
  };
  return [...names, ...(walk(collection.items, []) || [])].join(' / ');
};

export const RequestScreen = ({ item, collection, paneTab, setPaneTab, variables, envName, busy, onBack, onSend, onSave, onMenu, onEnv, onVariable, onResponse, onFull }) => {
  const unreadable = item.partial || item.loading;
  const supported = item.type === 'http-request' || item.type === 'graphql-request';
  const tabs = supported && !unreadable ? requestTabs(item) : [];
  const tab = tabs.some((t) => t.key === paneTab) ? paneTab : 'params';
  return (
    <div className="bw-screen bw-request-screen" data-testid="bw-phone-request-screen">
      <Header
        onBack={onBack}
        backLabel="Back to the list"
        actions={(
          <>
            {item.draft ? <IconButton icon="save" label="Save (unsaved changes)" onClick={onSave} dot testId="bw-phone-save" /> : null}
            <IconButton icon="more" label="More" onClick={onMenu} testId="bw-phone-menu" />
          </>
        )}
      >
        <MethodLabel method={methodOf(item)} />
        <span className="bw-title-text">{item.name}</span>
      </Header>

      {unreadable ? (
        <div className="bw-scroll bw-upstream-form">
          {item.partial ? <RequestNotLoaded item={item} collection={collection} /> : <RequestIsLoading item={item} />}
        </div>
      ) : null}

      {!unreadable && !supported ? (
        <div className="bw-scroll">
          <Empty>{methodOf(item)} requests cannot be edited or sent in phone mode yet.</Empty>
          <div className="bw-pad-x">
            <button type="button" className="bw-button bw-primary bw-block" onClick={onFull}>Open in full interface</button>
          </div>
        </div>
      ) : null}

      {!unreadable && supported ? (
        <>
          <div className="bw-context">
            <span className="bw-trail-text">{trailOf(collection, item)}</span>
            <button type="button" className="bw-pill" onClick={onEnv} data-testid="bw-phone-env">
              {envName || 'No Environment'}
              <Icon name="down" size={12} width={2.25} />
            </button>
          </div>
          <UrlBox item={item} collection={collection} variables={variables} onVariable={onVariable} />
          <Tabs tabs={tabs} active={tab} onChange={setPaneTab} label="Request" testId="bw-phone-request-tabs" />
          <div className="bw-pane" data-testid="bw-phone-editor">
            <RequestEditor tab={tab} item={item} collection={collection} variables={variables} onVariable={onVariable} />
          </div>
          <div className="bw-bottom">
            <LastResponse item={item} onOpen={onResponse} />
            <button type="button" className="bw-button bw-primary bw-block bw-send" onClick={onSend} disabled={busy} data-testid="bw-phone-send">Send</button>
          </div>
        </>
      ) : null}
    </div>
  );
};
