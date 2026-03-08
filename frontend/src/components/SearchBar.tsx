import { useRef, useEffect } from "react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  loading: boolean;
}

export function SearchBar({ value, onChange, loading }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="search-bar-wrap">
      <div className="search-bar">
        <span className="search-icon">
          {loading ? (
            <span className="spinner" />
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="11" cy="11" r="7" />
              <line x1="16.5" y1="16.5" x2="22" y2="22" />
            </svg>
          )}
        </span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search parts: MPN, LCSC code, description..."
          autoComplete="off"
          spellCheck={false}
          className="search-input"
        />
        {value && (
          <button className="search-clear" onClick={() => onChange("")} title="Clear">
            ×
          </button>
        )}
      </div>
    </div>
  );
}
