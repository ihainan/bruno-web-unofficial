/*
 * Running every request in a collection or folder, with upstream's runner.
 */
'use no memo'; // React Compiler mis-memoizes optional chains here (env?.variables read as env.variables).
import React, { useMemo, useState } from 'react';
import { useDispatch } from 'react-redux';
import get from 'lodash/get';
import toast from 'react-hot-toast';
import { runCollectionFolder, cancelRunnerExecution } from 'providers/ReduxStore/slices/collections/actions';
import useStoredRunnerExchange from 'hooks/useStoredRunnerExchange';
import useClearStoredRunnerExchanges from 'hooks/useClearStoredRunnerExchanges';
import { findItemInCollection } from 'utils/collections';
import { formatResponse, formatSize } from 'utils/common';
import { Header, Icon, Tabs, Sheet, Empty, methodClass } from './ui';
import { methodOf, statusTone } from './list';

const resultsOf = (r) => [
  ...(r.preRequestTestResults || []),
  ...(r.testResults || []),
  ...(r.postResponseTestResults || []),
  ...(r.assertionResults || [])
];

const failedOf = (r) => r.status === 'error' || !!r.error || resultsOf(r).some((t) => t.status === 'fail')
  || !!(r.preRequestScriptErrorMessage || r.postResponseScriptErrorMessage || r.testScriptErrorMessage);

const firstError = (r) => r.error || r.preRequestScriptErrorMessage || r.postResponseScriptErrorMessage || r.testScriptErrorMessage
  || (() => {
    const t = resultsOf(r).find((x) => x.status === 'fail');
    return t ? `${t.description || `${t.lhsExpr} ${t.rhsExpr}`}: ${t.error || 'failed'}` : '';
  })();

const RunDetail = ({ run, item, onClose }) => {
  const { responseReceived } = useStoredRunnerExchange(run);
  const response = responseReceived || {};
  const body = useMemo(() => {
    if (!response.data && !response.dataBuffer) return '';
    try {
      return formatResponse(response.data, response.dataBuffer, 'json');
    } catch (e) {
      return typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2);
    }
  }, [response.data, response.dataBuffer]);
  return (
    <Sheet title={item?.name || 'Request'} tall onClose={onClose} testId="bw-phone-run-detail" left={<button type="button" className="bw-text-button" onClick={onClose}>Close</button>}>
      <div className="bw-pad-x">
        <div className="bw-status-inline">
          {response.status ? <span className={`bw-${statusTone(response.status)} bw-strong`}>{response.status} {response.statusText}</span> : <span className="bw-danger">{run.status}</span>}
          {response.duration != null ? <span className="bw-muted">{response.duration} ms</span> : null}
          {response.size != null ? <span className="bw-muted">{formatSize(response.size)}</span> : null}
        </div>
        {firstError(run) ? <div className="bw-error-box bw-mono">{firstError(run)}</div> : null}
        {resultsOf(run).map((t, i) => (
          <div className="bw-result" key={t.uid || i}>
            <span className={t.status === 'pass' ? 'bw-ok' : 'bw-danger'}><Icon name={t.status === 'pass' ? 'pass' : 'fail'} width={2} /></span>
            <div className="bw-grow">
              <div>{t.description || `${t.lhsExpr} ${t.rhsExpr}`}</div>
              {t.status !== 'pass' && t.error ? <div className="bw-mono bw-danger bw-small">{t.error}</div> : null}
            </div>
          </div>
        ))}
        {body ? (
          <>
            <h3 className="bw-label">Body</h3>
            <pre className="bw-box bw-mono bw-code-block">{body}</pre>
          </>
        ) : null}
      </div>
    </Sheet>
  );
};

export const RunnerScreen = ({ collection, folderUid, envName, onBack, onEnv }) => {
  const dispatch = useDispatch();
  const clearStored = useClearStoredRunnerExchanges(collection.uid);
  const [filter, setFilter] = useState('all');
  const [detail, setDetail] = useState(null);
  const folder = folderUid ? findItemInCollection(collection, folderUid) : null;
  const result = collection.runnerResult;
  const mine = result && (result.info?.folderUid || null) === (folderUid || null);
  const runs = mine ? result.items || [] : [];
  const running = mine && result.info?.status && result.info.status !== 'ended';
  const done = runs.filter((r) => r.status === 'completed' || r.status === 'error');
  const skipped = runs.filter((r) => r.status === 'skipped');
  const failed = done.filter(failedOf);
  const passed = done.length - failed.length;
  const total = done.reduce((s, r) => s + (Number(r.responseReceived?.duration) || 0), 0);
  const shown = filter === 'passed' ? done.filter((r) => !failedOf(r)) : filter === 'failed' ? failed : runs;

  const run = () => clearStored()
    .then(() => dispatch(runCollectionFolder(collection.uid, folderUid || null, true, null, get(collection, 'runnerTags', { include: [], exclude: [] }))))
    .catch((e) => toast.error(e?.message || 'Could not start the run'));

  return (
    <div className="bw-screen" data-testid="bw-phone-runner">
      <Header
        onBack={onBack}
        backLabel="Back to the list"
        actions={(
          <button type="button" className="bw-pill" onClick={onEnv} data-testid="bw-phone-env">
            {envName || 'No Environment'}
            <Icon name="down" size={12} width={2.25} />
          </button>
        )}
      >
        <span className="bw-title-text">Run · {folder ? folder.name : collection.name}</span>
      </Header>
      {runs.length ? (
        <>
          <div className="bw-run-summary">
            <div className="bw-status-inline">
              <span className="bw-ok bw-strong bw-big" data-testid="bw-phone-run-passed">{passed} passed</span>
              {failed.length ? <span className="bw-danger bw-strong bw-big" data-testid="bw-phone-run-failed">{failed.length} failed</span> : null}
              <span className="bw-grow" />
              {skipped.length ? <span className="bw-muted bw-small">{skipped.length} skipped</span> : null}
              <span className="bw-muted bw-small">{runs.length} requests{total ? ` · ${(total / 1000).toFixed(1)} s` : ''}</span>
            </div>
            <div className="bw-progress" aria-hidden="true">
              <span className="bw-ok-bg" style={{ flex: passed }} />
              <span className="bw-danger-bg" style={{ flex: failed.length }} />
              <span className="bw-skipped-bg" style={{ flex: skipped.length }} />
              <span className="bw-pending-bg" style={{ flex: runs.length - done.length - skipped.length }} />
            </div>
          </div>
          <Tabs
            label="Filter results"
            active={filter}
            onChange={setFilter}
            tabs={[{ key: 'all', label: 'All', count: runs.length }, { key: 'passed', label: 'Passed', count: passed || null }, { key: 'failed', label: 'Failed', count: failed.length || null, countTone: failed.length ? 'danger' : null }]}
          />
          <div className="bw-scroll">
            {shown.map((r) => {
              const item = findItemInCollection(collection, r.uid);
              const skip = r.status === 'skipped';
              const settled = r.status === 'completed' || r.status === 'error' || skip;
              const bad = settled && !skip && failedOf(r);
              return (
                <button type="button" key={`${r.uid}-${r.requestUid || ''}`} className="bw-run-row" onClick={() => settled && setDetail(r)} data-testid="bw-phone-run-row">
                  <span className={skip || !settled ? 'bw-subtle' : bad ? 'bw-danger' : 'bw-ok'}>
                    {skip ? <Icon name="right" width={2} /> : settled ? <Icon name={bad ? 'fail' : 'pass'} width={2} /> : <span className="bw-spinner bw-spinner-small" />}
                  </span>
                  <span className="bw-grow">
                    <span className="bw-run-line">
                      {item ? <span className={methodClass(methodOf(item))}>{methodOf(item)}</span> : null}
                      <span className="bw-name">{item ? item.name : r.uid}</span>
                      {r.responseReceived?.status ? <span className={`bw-${statusTone(r.responseReceived.status)} bw-small`}>{r.responseReceived.status}</span> : null}
                      <span className="bw-subtle bw-small bw-time">{r.responseReceived?.duration != null ? `${r.responseReceived.duration} ms` : r.status === 'skipped' ? 'skipped' : ''}</span>
                    </span>
                    {bad && firstError(r) ? <span className="bw-mono bw-danger bw-small bw-run-error">{firstError(r)}</span> : null}
                    {skip && r.error ? <span className="bw-muted bw-small bw-run-error">{r.error}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <div className="bw-scroll">
          <Empty>Runs every request in {folder ? `the folder “${folder.name}”` : `“${collection.name}”`}, in order, with the selected environment.</Empty>
        </div>
      )}
      <div className="bw-bottom">
        {running ? (
          <button type="button" className="bw-button bw-secondary bw-block" onClick={() => dispatch(cancelRunnerExecution(result.info.cancelTokenUid))} data-testid="bw-phone-run-cancel">Stop</button>
        ) : (
          <button type="button" className="bw-button bw-primary bw-block" onClick={run} data-testid="bw-phone-run-start">{runs.length ? 'Run again' : 'Run'}</button>
        )}
      </div>
      {detail ? <RunDetail run={detail} item={findItemInCollection(collection, detail.uid)} onClose={() => setDetail(null)} /> : null}
    </div>
  );
};
