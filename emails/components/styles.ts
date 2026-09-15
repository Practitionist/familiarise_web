// #1653 — the inline style objects every template used to re-declare, lifted
// verbatim from `emails/payments/PaymentSuccessEmail.tsx` (`heading` from the
// auth templates) so new templates import them instead of copying them.

export const main = {
  backgroundColor: "#f5f5f5",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif',
};

export const container = {
  margin: "0 auto",
  padding: "20px 0",
  maxWidth: "600px",
};

export const content = {
  backgroundColor: "#ffffff",
  padding: "30px",
  borderRadius: "5px",
};

export const heading = {
  fontSize: "28px",
  fontWeight: "bold",
  color: "#333",
  lineHeight: "1.3",
  margin: "0 0 20px",
};

export const paragraph = {
  fontSize: "16px",
  lineHeight: "1.5",
  color: "#444",
  margin: "0 0 20px",
};

export const buttonContainer = {
  textAlign: "center" as const,
  margin: "30px 0",
};

export const button = {
  backgroundColor: "#000000",
  borderRadius: "5px",
  color: "#fff",
  fontSize: "16px",
  fontWeight: "600",
  textDecoration: "none",
  textAlign: "center" as const,
  display: "block",
  padding: "14px 24px",
};

export const divider = {
  borderColor: "#e0e0e0",
  margin: "30px 0",
};

export const link = {
  color: "#666",
  textDecoration: "underline",
};
