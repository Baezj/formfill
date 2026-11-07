// Settings: profile + prefs in localStorage (tiny); signatures in IndexedDB (images).
import { db } from './db.js';

const KEY = 'formfill.settings.v1';

const DEFAULTS = {
  profile: {
    fullName: '', firstName: '', lastName: '', email: '', phone: '',
    address: '', city: '', state: '', zip: '', dob: '', company: '', title: ''
  },
  snippets: [],           // [{label, value}]
  prefs: { dateFormat: 'MM/DD/YYYY', fontSize: 12, color: '#111111', flatten: true, inkWidth: 2 }
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...structuredClone(DEFAULTS), legacySigs: [] };
    const s = JSON.parse(raw);
    return {
      profile: { ...DEFAULTS.profile, ...(s.profile || {}) },
      snippets: Array.isArray(s.snippets) ? s.snippets : [],
      prefs: { ...DEFAULTS.prefs, ...(s.prefs || {}) },
      legacySigs: Array.isArray(s.signatures) ? s.signatures : []
    };
  } catch { return { ...structuredClone(DEFAULTS), legacySigs: [] }; }
}

export const store = {
  data: load(),
  signatures: [],         // [{id, kind:'signature'|'initials', dataUrl, w, h, created}] — cached from IndexedDB
  onSaveError: null,
  save() {
    const { profile, snippets, prefs } = this.data;
    try { localStorage.setItem(KEY, JSON.stringify({ profile, snippets, prefs })); }
    catch (e) { console.warn('settings save failed', e); if (this.onSaveError) this.onSaveError(e); }
  },
  get profile() { return this.data.profile; },
  get prefs() { return this.data.prefs; },
  get snippets() { return this.data.snippets; },
  async init() {
    try {
      this.signatures = (await db.sigsAll()).sort((a, b) => (b.created || 0) - (a.created || 0));
      // One-time move of signatures saved by an earlier version in localStorage.
      if (this.data.legacySigs.length) {
        for (const s of this.data.legacySigs) { if (!this.signatures.find(x => x.id === s.id)) { await db.sigPut(s); this.signatures.push(s); } }
        this.data.legacySigs = [];
        this.save();
      }
    } catch (e) { console.warn('signature store', e); }
  },
  sigsOf(kind) { return this.signatures.filter(s => s.kind === kind); },
  async addSignature(sig) {
    sig.id = sig.id || ('s' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    sig.created = Date.now();
    this.signatures.unshift(sig);
    try { await db.sigPut(sig); } catch (e) { console.warn(e); if (this.onSaveError) this.onSaveError(e); }
    return sig;
  },
  async updateSignature(id, patch) {
    const i = this.signatures.findIndex(s => s.id === id); if (i < 0) return null;
    const sig = { ...this.signatures[i], ...patch, id, updated: Date.now() };
    this.signatures[i] = sig;
    try { await db.sigPut(sig); } catch (e) { console.warn(e); if (this.onSaveError) this.onSaveError(e); }
    return sig;
  },
  async removeSignature(id) {
    this.signatures = this.signatures.filter(s => s.id !== id);
    try { await db.sigDelete(id); } catch (e) { console.warn(e); }
  }
};

export const PROFILE_FIELDS = [
  ['fullName', 'Full name', 'wide', 'name'],
  ['firstName', 'First name', '', 'given-name'], ['lastName', 'Last name', '', 'family-name'],
  ['email', 'Email', 'wide', 'email'],
  ['phone', 'Phone', '', 'tel'], ['dob', 'Date of birth', '', 'bday'],
  ['address', 'Street address', 'wide', 'street-address'],
  ['city', 'City', '', 'address-level2'], ['state', 'State', '', 'address-level1'], ['zip', 'ZIP', '', 'postal-code'],
  ['company', 'Company', '', 'organization'], ['title', 'Job title', '', 'organization-title']
];

export function formatDate(d = new Date(), fmt = store.prefs.dateFormat) {
  const p2 = n => String(n).padStart(2, '0');
  const M = d.getMonth() + 1, D = d.getDate(), Y = d.getFullYear();
  switch (fmt) {
    case 'M/D/YYYY': return `${M}/${D}/${Y}`;
    case 'DD/MM/YYYY': return `${p2(D)}/${p2(M)}/${Y}`;
    case 'YYYY-MM-DD': return `${Y}-${p2(M)}-${p2(D)}`;
    case 'long': return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    default: return `${p2(M)}/${p2(D)}/${Y}`;
  }
}
