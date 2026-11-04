'use no memo'; // React Compiler mis-memoizes optional chains here (env?.variables read as env.variables).
import styled from 'styled-components';

// Bruno's theme (light, dark and their variants) as variables for phone.css,
// so phone mode follows whichever theme the user picked.
const themed = (props) => {
  const t = props.theme;
  const m = t.request?.methods || {};
  const text = t.colors?.text || {};
  const border = t.border || {};
  const bg = t.background || {};
  const primary = t.button2?.color?.primary || {};
  const variable = t.codemirror?.variable || {};
  const status = t.status || {};
  const dark = t.mode === 'dark';
  return `
    --bw-bg: ${t.bg};
    --bw-mantle: ${bg.mantle || t.bg};
    --bw-surface0: ${bg.surface0 || t.bg};
    --bw-surface1: ${bg.surface1 || t.bg};
    --bw-text: ${t.text};
    --bw-muted: ${text.muted || t.text};
    --bw-subtle: ${text.subtext0 || text.muted || t.text};
    --bw-placeholder: ${t.input?.placeholder?.color || text.subtext0 || t.text};
    --bw-border: ${border.border1 || 'rgba(128, 128, 128, 0.3)'};
    --bw-border-faint: ${border.border0 || border.border1 || 'rgba(128, 128, 128, 0.2)'};
    --bw-border-strong: ${border.border3 || border.border2 || 'rgba(128, 128, 128, 0.5)'};
    --bw-input-border: ${t.input?.border || border.border2 || 'rgba(128, 128, 128, 0.4)'};
    --bw-input-bg: ${t.input?.bg || t.bg};
    --bw-brand: ${primary.bg || t.brand};
    --bw-on-brand: ${primary.text || '#fff'};
    --bw-brand-text: ${t.primary?.text || t.brand};
    --bw-tab-active: ${t.tabs?.active?.border || t.brand};
    --bw-link: ${t.textLink || t.brand};
    --bw-accent: ${t.colors?.accent || t.brand};
    --bw-draft: ${t.draftColor || t.brand};
    --bw-ok: ${status.success?.text || text.green || 'green'};
    --bw-danger: ${status.danger?.text || text.danger || 'red'};
    --bw-warning: ${status.warning?.text || text.warning || 'orange'};
    --bw-var-valid: ${variable.valid || text.green || 'green'};
    --bw-var-invalid: ${variable.invalid || text.danger || 'red'};
    --bw-var-prompt: ${variable.prompt || t.textLink || 'blue'};
    --bw-shadow: ${t.shadow?.lg || '0 2px 12px rgba(0, 0, 0, 0.15)'};
    --bw-shadow-sm: ${t.shadow?.sm || '0 1px 3px rgba(0, 0, 0, 0.12)'};
    --bw-scrim: ${dark ? 'rgba(0, 0, 0, 0.55)' : 'rgba(0, 0, 0, 0.32)'};
    --bw-get: ${m.get}; --bw-post: ${m.post}; --bw-put: ${m.put}; --bw-patch: ${m.patch};
    --bw-delete: ${m.delete}; --bw-options: ${m.options}; --bw-head: ${m.head};
  `;
};

export const Themed = styled.div`${themed}`;
export const ThemedButton = styled.button`${themed}`;
