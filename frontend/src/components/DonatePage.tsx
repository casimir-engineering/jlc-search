export function DonatePage({ onBack }: { onBack: () => void }) {
  return (
    <div className="donate-page">
      <button className="donate-back" onClick={onBack}>&larr; Back to search</button>
      <h1>Support jlc-search</h1>
      <p className="donate-subtitle">
        This tool is free and open source. If it saved you time, consider helping cover our hosting costs.
      </p>
      <p className="donate-subtitle">
        This infrastructure costs $35/month because Asian servers with reasonable bandwidth are particularly expensive.
        If I get enough donations I will start a Europe server, then a US one.
      </p>

      <div className="donate-grid">
        <div className="donate-card">
          <h2>WeChat Pay</h2>
          <img src="/qr1.webp" alt="WeChat Pay QR" className="donate-qr" />
        </div>

        <div className="donate-card">
          <h2>Alipay</h2>
          <img src="/qr2.webp" alt="Alipay QR" className="donate-qr" />
        </div>
      </div>

      <div className="donate-other">
        <p>Other ways to support:</p>
        <div className="donate-links">
          <a href="https://github.com/casimir-engineering/jlc-search" target="_blank" rel="noopener noreferrer" className="donate-link-btn">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{verticalAlign: '-2px', marginRight: '4px'}}><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
            Star on GitHub
          </a>
        </div>
      </div>
    </div>
  );
}
