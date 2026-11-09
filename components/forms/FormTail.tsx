import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The end of a public form: a honeypot only bots fill, the form-level error,
 * and the submit button. Shared by the contact and demo forms so the spam
 * guard and the sending state cannot drift apart.
 */
export function FormTail({
  idPrefix,
  honeypot,
  onHoneypotChange,
  error,
  sending,
  submitLabel,
}: Readonly<{
  /** Makes the honeypot's id unique when two forms exist in one app. */
  idPrefix: string;
  honeypot: string;
  onHoneypotChange: (value: string) => void;
  error: string | null;
  sending: boolean;
  submitLabel: string;
}>) {
  const id = `${idPrefix}-website`;
  return (
    <>
      {/* Honeypot: hidden from people, irresistible to bots. */}
      <div aria-hidden className="hidden">
        <Label htmlFor={id}>Website</Label>
        <Input
          id={id}
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(e) => onHoneypotChange(e.target.value)}
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      <Button className="w-full" type="submit" size="lg" disabled={sending}>
        {sending ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            Sending…
          </>
        ) : (
          submitLabel
        )}
      </Button>
    </>
  );
}
