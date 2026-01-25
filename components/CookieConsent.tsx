"use client";

import CookieConsent from "react-cookie-consent";

export default function CookieConsentBanner() {
  return (
    <CookieConsent
      location="bottom"
      buttonText="Accept"
      declineButtonText="Decline"
      enableDeclineButton
      cookieName="familiarise_consent"
      style={{
        background: "#18181b",
        padding: "16px 24px",
        alignItems: "center",
      }}
      buttonStyle={{
        background: "#fff",
        color: "#18181b",
        fontSize: "14px",
        fontWeight: "500",
        borderRadius: "6px",
        padding: "8px 16px",
      }}
      declineButtonStyle={{
        background: "transparent",
        border: "1px solid #71717a",
        color: "#fff",
        fontSize: "14px",
        fontWeight: "500",
        borderRadius: "6px",
        padding: "8px 16px",
      }}
      expires={365}
    >
      We use cookies to enhance your experience. By continuing to visit this
      site you agree to our use of cookies.{" "}
      <a href="/privacy" className="underline text-zinc-300 hover:text-white">
        Learn more
      </a>
    </CookieConsent>
  );
}
