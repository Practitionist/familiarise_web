"use client";

import { useState } from "react";
import { z } from "zod";

import { invalidProps } from "@/components/ui/field-error";
import { toast } from "@/components/ui/use-toast";
import { authClient } from "@/lib/auth-client";
import { withReauth } from "@/lib/auth/reauth-client";
import {
  humanizeAuthError,
  isPasskeyCancellation,
} from "@/lib/labels/auth-errors";

const inputClass =
  "w-full max-w-sm rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-white";
const secondaryButton =
  "rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-white disabled:opacity-50";
const linkButton =
  "text-sm text-neutral-300 underline-offset-4 hover:text-white hover:underline disabled:opacity-50";

const ERROR_ID = "passkey-error";

const failureShape = z.object({
  code: z.string().optional(),
  status: z.number().optional(),
});
type Failure = z.infer<typeof failureShape>;

/** The passkey client's error unions differ per call; keep only what the catalog reads. */
async function settle(
  pending: Promise<{ error: unknown }>,
): Promise<{ error: Failure | null }> {
  const { error } = await pending;
  if (!error) return { error: null };
  const parsed = failureShape.safeParse(error);
  return { error: parsed.success ? parsed.data : {} };
}

function formatCreated(value: Date | string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}

/** Operator passkeys: list, add (step-up gated), rename and remove. */
export function PasskeyList() {
  const {
    data: passkeys,
    isPending,
    error: loadError,
  } = authClient.useListPasskeys();
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  async function perform(
    key: string,
    call: () => Promise<{ error: Failure | null }>,
  ): Promise<boolean> {
    setBusy(key);
    setError(null);
    try {
      const { error: failure } = await call();
      if (!failure) return true;
      if (!isPasskeyCancellation(failure.code)) {
        const copy = humanizeAuthError("signin", failure);
        setError(`${copy.title}. ${copy.description}`);
      }
      return false;
    } catch {
      const copy = humanizeAuthError("signin", { status: 0 });
      setError(`${copy.title}. ${copy.description}`);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function addPasskey(event: React.FormEvent) {
    event.preventDefault();
    const name = newName.trim() || undefined;
    const ok = await perform("add", () =>
      withReauth(() => settle(authClient.passkey.addPasskey({ name }))),
    );
    if (!ok) return;
    setNewName("");
    toast({ title: "Passkey added" });
  }

  async function renamePasskey(event: React.FormEvent) {
    event.preventDefault();
    if (!renaming) return;
    const { id, name } = renaming;
    const ok = await perform(`rename:${id}`, () =>
      settle(authClient.passkey.updatePasskey({ id, name: name.trim() })),
    );
    if (ok) setRenaming(null);
  }

  async function deletePasskey(id: string) {
    const ok = await perform(`delete:${id}`, () =>
      settle(authClient.passkey.deletePasskey({ id })),
    );
    if (!ok) return;
    setConfirmingDelete(null);
    toast({ title: "Passkey removed" });
  }

  return (
    <div className="mt-6 border-t border-neutral-800 pt-6">
      <h3 className="text-base font-semibold text-white">Passkeys</h3>
      <p className="mt-1 text-sm text-neutral-400">
        Sign in with your device&apos;s fingerprint, face or PIN instead of a
        password and code. Your authenticator app stays your backup.
      </p>

      {isPending ? (
        <p className="mt-3 text-sm text-neutral-400">Loading passkeys…</p>
      ) : loadError ? (
        <p className="mt-3 text-sm text-red-400">
          We couldn&apos;t load your passkeys. Refresh the page to try again.
        </p>
      ) : passkeys && passkeys.length > 0 ? (
        <ul className="mt-3 divide-y divide-neutral-800 rounded-md border border-neutral-800">
          {passkeys.map((passkey) => {
            const label = passkey.name || "Passkey";
            const created = formatCreated(passkey.createdAt);
            return (
              <li key={passkey.id} className="p-3">
                {renaming?.id === passkey.id ? (
                  <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(event) => void renamePasskey(event)}
                  >
                    <label
                      className="sr-only"
                      htmlFor={`passkey-name-${passkey.id}`}
                    >
                      Passkey name
                    </label>
                    <input
                      id={`passkey-name-${passkey.id}`}
                      autoFocus
                      autoComplete="off"
                      value={renaming.name}
                      onChange={(e) =>
                        setRenaming({ id: passkey.id, name: e.target.value })
                      }
                      className={inputClass}
                      {...invalidProps(error, ERROR_ID)}
                    />
                    <button
                      type="submit"
                      disabled={busy !== null || !renaming.name.trim()}
                      className={secondaryButton}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenaming(null)}
                      className={linkButton}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm text-white">{label}</p>
                      {created ? (
                        <p className="text-xs text-neutral-400">
                          Added {created}
                        </p>
                      ) : null}
                    </div>
                    {confirmingDelete === passkey.id ? (
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-neutral-300">
                          Remove this passkey?
                        </span>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void deletePasskey(passkey.id)}
                          className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                        >
                          {busy === `delete:${passkey.id}`
                            ? "Removing…"
                            : "Remove"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingDelete(null)}
                          className={linkButton}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          disabled={busy !== null}
                          aria-label={`Rename ${label}`}
                          onClick={() => {
                            setConfirmingDelete(null);
                            setRenaming({
                              id: passkey.id,
                              name: passkey.name ?? "",
                            });
                          }}
                          className={linkButton}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          disabled={busy !== null}
                          aria-label={`Remove ${label}`}
                          onClick={() => {
                            setRenaming(null);
                            setConfirmingDelete(passkey.id);
                          }}
                          className={linkButton}
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-neutral-400">No passkeys yet.</p>
      )}

      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(event) => void addPasskey(event)}
      >
        <div className="grow">
          <label
            className="block text-sm text-neutral-300"
            htmlFor="passkey-new-name"
          >
            Name (optional)
          </label>
          <input
            id="passkey-new-name"
            autoComplete="off"
            placeholder="e.g. Work laptop"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className={`mt-1 ${inputClass}`}
            {...(renaming ? {} : invalidProps(error, ERROR_ID))}
          />
        </div>
        <button
          type="submit"
          disabled={busy !== null}
          className={secondaryButton}
        >
          {busy === "add" ? "Waiting for your device…" : "Add passkey"}
        </button>
      </form>

      {error ? (
        <p id={ERROR_ID} role="alert" className="mt-3 text-sm text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
