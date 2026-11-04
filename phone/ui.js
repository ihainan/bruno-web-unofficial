/*
 * Building blocks shared by the phone screens: icons, the header, tab bars,
 * bottom sheets, menu rows, and text that shows {{variables}} the way the
 * desktop editors colour them.
 */
'use no memo'; // React Compiler mis-memoizes optional chains here (env?.variables read as env.variables).
import React, { useEffect } from 'react';
import get from 'lodash/get';

const PATHS = {
  back: ['m15 18-6-6 6-6'],
  down: ['m6 9 6 6 6-6'],
  up: ['m18 15-6-6-6 6'],
  right: ['m9 18 6-6-6-6'],
  plus: ['M5 12h14', 'M12 5v14'],
  more: ['M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'm20 20-3.5-3.5'],
  save: ['M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7', 'M7 3v4a1 1 0 0 0 1 1h7'],
  copy: ['M10 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
  share: ['M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8', 'm16 6-4-4-4 4', 'M12 2v13'],
  bookmark: ['m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z'],
  download: ['M12 15V3', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5'],
  terminal: ['m4 17 6-6-6-6', 'M12 19h8'],
  code: ['m16 18 6-6-6-6', 'm8 6-6 6 6 6'],
  pencil: ['M12 20h9', 'M16.4 3.6a2 2 0 0 1 2.8 2.8L7 18.6 3 20l1.4-4z'],
  move: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z', 'm12 10 3 3-3 3', 'M9 13h6'],
  folder: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
  run: ['M6 4v16', 'm10 4 10 8-10 8z'],
  monitor: ['M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M8 21h8', 'M12 17v4'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  check: ['M20 6 9 17l-5-5'],
  close: ['M18 6 6 18', 'm6 6 12 12'],
  pass: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'm8.5 12.5 2.5 2.5 4.5-5'],
  fail: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'm15 9-6 6', 'm9 9 6 6'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  box: ['M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z', 'm3.3 7 8.7 5 8.7-5', 'M12 22V12'],
  eye: ['M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  eyeOff: ['M10.7 5.1A10.7 10.7 0 0 1 21.9 11.7a1 1 0 0 1 0 .7 10.8 10.8 0 0 1-1.4 2.4', 'M14.1 14.2a3 3 0 0 1-4.2-4.2', 'M17.5 17.5A10.7 10.7 0 0 1 2.1 12.4a1 1 0 0 1 0-.7 10.8 10.8 0 0 1 4.4-5.3', 'm2 2 20 20'],
  help: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3', 'M12 17h.01'],
  stop: ['M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z'],
  file: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4']
};

export const Icon = ({ name, size = 18, width = 1.75, className = 'bw-icon' }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {PATHS[name].map((d) => <path key={d} d={d} />)}
  </svg>
);

export const IconButton = ({ icon, label, onClick, testId, dot, disabled, size = 18 }) => (
  <button type="button" className="bw-icon-button" aria-label={label} title={label} onClick={onClick} data-testid={testId} disabled={disabled}>
    <Icon name={icon} size={size} width={icon === 'more' ? 2.25 : 1.75} />
    {dot ? <span className="bw-dot bw-dot-on-icon" aria-hidden="true" /> : null}
  </button>
);

export const methodClass = (method) => `bw-method bw-${String(method).toLowerCase()}`;

export const MethodLabel = ({ method }) => <span className={methodClass(method)}>{method}</span>;

export const Header = ({ onBack, backLabel = 'Back', children, actions }) => (
  <header className="bw-phone-header">
    {onBack ? <IconButton icon="back" label={backLabel} onClick={onBack} testId="bw-phone-back" size={20} /> : null}
    <div className={`bw-phone-title${onBack ? '' : ' bw-phone-title-root'}`}>{children}</div>
    {actions}
  </header>
);

// A row of text tabs, like the desktop request and response panes.
export const Tabs = ({ tabs, active, onChange, label, testId, trailing }) => (
  <nav className="bw-tabs" aria-label={label} data-testid={testId}>
    {tabs.map((t) => (
      <button
        key={t.key}
        type="button"
        className={`bw-tab${t.key === active ? ' bw-active' : ''}`}
        aria-current={t.key === active ? 'page' : undefined}
        onClick={() => onChange(t.key)}
        data-testid={`bw-tab-${t.key}`}
      >
        {t.label}
        {t.count ? <sup className={t.countTone ? `bw-${t.countTone}` : undefined}>{t.count}</sup> : null}
        {t.dot ? <span className="bw-tab-dot" aria-label="has content" /> : null}
      </button>
    ))}
    {trailing ? <span className="bw-tabs-trailing">{trailing}</span> : null}
  </nav>
);

// A panel that slides up from the bottom over a dimmed screen. Tapping the
// dimmed part or pressing Escape closes it.
export const Sheet = ({ onClose, label, title, left, right, tall, children, testId }) => {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="bw-sheet-layer">
      <button type="button" className="bw-scrim" aria-label="Close" onClick={onClose} />
      <div className={`bw-sheet${tall ? ' bw-sheet-tall' : ''}`} role="dialog" aria-modal="true" aria-label={label || title} data-testid={testId}>
        <span className="bw-sheet-handle" aria-hidden="true" />
        {title || left || right ? (
          <div className="bw-sheet-head">
            <span className="bw-sheet-side">{left}</span>
            {title ? <h2 className="bw-sheet-title">{title}</h2> : null}
            <span className="bw-sheet-side bw-end">{right}</span>
          </div>
        ) : null}
        <div className="bw-sheet-body">{children}</div>
      </div>
    </div>
  );
};

export const MenuRow = ({ icon, label, hint, danger, onClick, testId, disabled }) => (
  <button type="button" className={`bw-menu-row${danger ? ' bw-danger' : ''}`} onClick={onClick} data-testid={testId} disabled={disabled}>
    {icon ? <Icon name={icon} /> : null}
    <span className="bw-grow">{label}</span>
    {hint ? <span className="bw-hint">{hint}</span> : null}
  </button>
);

export const MenuDivider = () => <div className="bw-menu-divider" role="separator" />;

// {{name}} segments of a string, each marked valid, invalid or prompt the way
// upstream's editors mark them (utils/common/codemirror.js).
const VAR = /\{\{([^{}]+)\}\}/g;
export const variableState = (name, variables) => {
  const n = name.trim();
  if (n.startsWith('?')) return 'prompt';
  if (n.startsWith('$') || n.startsWith('process.env.')) return get(variables, n) !== undefined || n.startsWith('$') ? 'valid' : 'invalid';
  return get(variables, n) !== undefined ? 'valid' : 'invalid';
};

export const splitVariables = (text) => {
  const parts = [];
  let last = 0;
  String(text ?? '').replace(VAR, (match, name, at) => {
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ text: match, name: name.trim() });
    last = at + match.length;
    return match;
  });
  if (last < String(text ?? '').length) parts.push({ text: String(text).slice(last) });
  return parts;
};

// Long URLs break after / ? & so they wrap where a reader expects.
// (No lookbehind in the regex: Safari before 16.4 cannot parse it.)
const breakable = (s) => s.replace(/([/?&=])/g, '$1\u0000').split('\u0000').flatMap((piece, i) => (i ? [<wbr key={i} />, piece] : [piece]));

export const VarText = ({ text, variables, onVariable, placeholder }) => {
  const parts = splitVariables(text);
  if (!parts.length) return <span className="bw-placeholder">{placeholder}</span>;
  return parts.map((p, i) => {
    if (!p.name) return <React.Fragment key={i}>{breakable(p.text)}</React.Fragment>;
    const cls = `bw-var bw-var-${variableState(p.name, variables)}`;
    if (!onVariable) return <span key={i} className={cls}>{p.text}</span>;
    return (
      <button
        key={i}
        type="button"
        className={cls}
        onClick={(e) => {
          e.stopPropagation();
          onVariable(p.name, e.currentTarget);
        }}
        data-testid="bw-phone-var"
      >
        {p.text}
      </button>
    );
  });
};

export const Empty = ({ children }) => <p className="bw-phone-empty">{children}</p>;
