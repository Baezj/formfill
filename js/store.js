// Small localStorage-backed settings: profile, signatures, preferences.
const KEY = 'formfill.settings.v1';

const DEFAULTS = {
  profile: {
    fullName: '', firstName: '', lastName: '', email: '', phone: '',
    address: '', city: '', state: '', zip: '', dob: '', company: '', title: ''
  },
  snippets: [],           // [{label, value}]
  signatures: [],         // [{id, kind:'signature'|'initials', dataUrl, w, h, created}]
  prefs: { dateFormat: 'MM/DD/YYYY', fontSize: 12, color: '#111111', flatten: true }
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const s = JSON.parse(raw);
    return {
      profile: { ...DEFAULTS.profile, ...(s.profile || {}) },
      snippets: Array.isArray(s.snippets) ? s.snippets : [],
      signatures: Array.isArray(s.signatures) ? s.signatures : [],
      prefs: { ...DEFAULTS.prefs, ...(s.prefs || {}) }
    };
  } catch { return structuredClone(DEFAULTS); }
}

export const store = {
  data: load(),
  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); }
    catch (e) { console.warn('settings save failed', e); }
  },
  get profile() { return this.data.profile; },
  get prefs() { return this.data.prefs; },
  get snippets() { return this.data.snippets; },
  get signatures() { return this.data.signatures; },
  sigsOf(kind) { return this.data.signatures.filter(s => s.kind === kind); },
  addSignature(sig) {
    sig.id = sig.id || ('s' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    sig.created = Date.now();
    this.data.signatures.unshift(sig);
    if (this.data.signatures.length > 24) this.data.signatures.length = 24;
    this.save();
    return sig;
  },
  removeSignature(id) {
    this.data.signatures = this.data.signatures.filter(s => s.id !== id);
    this.save();
  }
};

export const PROFILE_FIELDS = [
  ['fullName', 'Full name', 'wide'],
  ['firstName', 'First name'], ['lastName', 'Last name'],
  ['email', 'Email', 'wide'],
  ['phone', 'Phone'], ['dob', 'Date of birth'],
  ['address', 'Street address', 'wide'],
  ['city', 'City'], ['state', 'State'], ['zip', 'ZIP'],
  ['company', 'Company'], ['title', 'Job title']
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
