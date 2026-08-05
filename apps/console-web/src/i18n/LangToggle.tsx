import type { Lang } from './lang.js';

export function LangToggle({ lang, onChange }: { lang: Lang; onChange: (lang: Lang) => void }) {
  return (
    <div className="lang-toggle" role="group" aria-label="Language">
      <button type="button" className={lang === 'en' ? 'active' : ''} onClick={() => onChange('en')}>
        EN
      </button>
      <button type="button" className={lang === 'da' ? 'active' : ''} onClick={() => onChange('da')}>
        Dansk
      </button>
    </div>
  );
}
