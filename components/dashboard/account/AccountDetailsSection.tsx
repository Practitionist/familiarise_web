"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Camera, Loader2, Upload } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Section } from "@/components/dashboard/Section";
import {
  FieldError,
  SettingsSaveBar,
  invalidProps,
} from "@/components/dashboard/SettingsLayout";
import { useToast } from "@/hooks/use-toast";
import { useSession } from "@/lib/auth-client";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

interface Details {
  name: string;
  phone: string;
  address: string;
  timezone: string;
}

/** Every IANA zone the browser knows, with the saved one kept if it is not. */
function zoneOptions(current: string): string[] {
  const zones =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  return current && !zones.includes(current) ? [current, ...zones] : zones;
}

function AvatarEditor({
  image,
  name,
}: Readonly<{ image: string | null | undefined; name: string }>) {
  const { toast } = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);

  const reset = () => {
    setFile(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
  };

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.files?.[0];
    if (!next) return;
    if (next.size > MAX_AVATAR_BYTES) {
      toast({
        title: "File too large",
        description: "Please select an image under 2MB.",
        variant: "destructive",
      });
      return;
    }
    if (preview) URL.revokeObjectURL(preview);
    setFile(next);
    setPreview(URL.createObjectURL(next));
  };

  const send = async (method: "POST" | "DELETE") => {
    setBusy(method === "POST" ? "upload" : "remove");
    try {
      let body: FormData | undefined;
      if (method === "POST" && file) {
        body = new FormData();
        body.append("file", file);
      }
      const res = await fetch("/api/user/profile-image", { method, body });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
      };
      if (!res.ok || !data.success) {
        throw new Error(data.error || "That didn't go through.");
      }
      toast({
        title:
          method === "POST"
            ? "Profile picture updated"
            : "Profile picture removed",
      });
      setOpen(false);
      reset();
      router.refresh();
    } catch (error) {
      toast({
        title: "Couldn't update your picture",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <Avatar className="h-16 w-16 border border-border">
        <AvatarImage src={image ?? ""} alt="" />
        <AvatarFallback className="text-lg font-semibold">
          {name.charAt(0) || "U"}
        </AvatarFallback>
      </Avatar>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            <Camera className="mr-1.5 h-4 w-4" />
            Change photo
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Profile photo</DialogTitle>
            <DialogDescription>JPEG, PNG or WebP, up to 2MB.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="flex h-32 w-32 items-center justify-center overflow-hidden rounded-full bg-muted">
              {preview || image ? (
                <Image
                  src={preview ?? image!}
                  alt=""
                  width={128}
                  height={128}
                  className="h-full w-full object-cover"
                  unoptimized={!!preview}
                />
              ) : (
                <Upload className="h-10 w-10 text-muted-foreground" />
              )}
            </div>
            <Input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="max-w-xs"
              aria-label="Choose a photo"
              onChange={pick}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            {image && (
              <Button
                variant="outline"
                onClick={() => void send("DELETE")}
                disabled={busy !== null}
                className="mr-auto"
              >
                {busy === "remove" && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Remove
              </Button>
            )}
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              onClick={() => void send("POST")}
              disabled={!file || busy !== null}
            >
              {busy === "upload" && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * #1527 §14 — name, photo, phone, address and timezone, from the retired
 * `/profile` page. Saves through the same `PUT /api/user/:id` it used.
 */
export function AccountDetailsSection() {
  const { data: session } = useSession();
  const { toast } = useToast();
  const user = session?.user;
  const saved = useMemo<Details>(
    () => ({
      name: user?.name ?? "",
      phone: user?.phone ?? "",
      address: user?.address ?? "",
      timezone: user?.timezone ?? "",
    }),
    [user?.name, user?.phone, user?.address, user?.timezone],
  );
  const [baseline, setBaseline] = useState<Details>(saved);
  const [form, setForm] = useState<Details>(saved);
  const [nameError, setNameError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // The session lands after first paint; adopt it until the user edits.
  useEffect(() => {
    setBaseline(saved);
    setForm(saved);
  }, [saved]);

  const isDirty = (Object.keys(form) as (keyof Details)[]).some(
    (key) => form[key] !== baseline[key],
  );
  const set = (key: keyof Details) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user?.id) return;
    if (!form.name.trim()) {
      setNameError("Enter your name.");
      return;
    }
    setNameError(null);
    setIsSaving(true);
    try {
      const res = await fetch(`/api/user/${user.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          phone: form.phone,
          address: form.address,
          currentTimezone: form.timezone,
        }),
      });
      if (!res.ok) throw new Error("save failed");
      setBaseline(form);
      toast({ title: "Account details saved" });
    } catch {
      toast({
        title: "Couldn't save your details",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const zones = zoneOptions(form.timezone);

  return (
    <Section
      title="Your details"
      description="How experts and our team see and reach you."
      variant="card"
    >
      <form onSubmit={submit} className="space-y-5">
        <AvatarEditor image={user?.image} name={form.name} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="account-name">Full name</Label>
            <Input
              id="account-name"
              value={form.name}
              onChange={(e) => set("name")(e.target.value)}
              autoComplete="name"
              {...invalidProps(nameError, "account-name-error")}
            />
            <FieldError id="account-name-error" message={nameError} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="account-email">Email</Label>
            <Input
              id="account-email"
              value={user?.email ?? ""}
              disabled
              readOnly
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="account-phone">Phone</Label>
            <Input
              id="account-phone"
              value={form.phone}
              onChange={(e) => set("phone")(e.target.value)}
              autoComplete="tel"
              placeholder="+91 98765 43210"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="account-timezone">Timezone</Label>
            <Select
              value={form.timezone || undefined}
              onValueChange={set("timezone")}
            >
              <SelectTrigger id="account-timezone">
                <SelectValue placeholder="Choose your timezone" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {zones.map((zone) => (
                  <SelectItem key={zone} value={zone}>
                    {zone.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="account-address">Address</Label>
            <Input
              id="account-address"
              value={form.address}
              onChange={(e) => set("address")(e.target.value)}
              autoComplete="street-address"
            />
          </div>
        </div>
        <SettingsSaveBar
          isSaving={isSaving}
          isDirty={isDirty}
          onReset={() => {
            setForm(baseline);
            setNameError(null);
          }}
        />
      </form>
    </Section>
  );
}
