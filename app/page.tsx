import Link from "next/link";

export default function Home() {
  return (
    <main className="shell">
      <div>
        <h1 className="wordmark">
          QR<span>Drop</span>
        </h1>
        <p className="tagline">Send files instantly. No upload. No account.</p>
      </div>

      <div className="choices">
        <Link className="card-btn" href="/send">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 19V5" />
            <path d="m5 12 7-7 7 7" />
          </svg>
          Send
          <small>a file</small>
        </Link>
        <Link className="card-btn" href="/receive">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <path d="M14 14h3v3h-3zM20 14h1M14 20h3M20 18v3" />
          </svg>
          Receive
          <small>scan a code</small>
        </Link>
      </div>

      <p className="footnote">
        Phone, laptop, iPhone, Android — anything with a browser, in any
        combination. The file travels straight between the two devices over an
        encrypted peer-to-peer channel and never touches a server.
      </p>
    </main>
  );
}
