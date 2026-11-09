"use client";

import { ChevronDown, Menu, X } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import {
  accountBaseLinks,
  accountFacetLinks,
} from "@/lib/navigation/account-menu";
import { useDashboardFacets } from "@/hooks/useDashboardFacets";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import { Skeleton } from "@/components/ui/skeleton";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { BrandWordmark } from "@/components/brand/BrandWordmark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useCurrency, SUPPORTED_CURRENCIES } from "@/hooks/useCurrency";
import { RATE_PROVIDER_NAME, RATE_PROVIDER_URL } from "@/lib/currency-codes";
import { resolveAuthView, useRememberedAuth } from "@/hooks/useRememberedAuth";
import { hasDarkHero, isChromeHidden } from "@/lib/navigation/public-chrome";
import {
  NAV_FLAT_LINKS,
  NAV_GROUPS,
  type NavDropdownGroup,
  type NavDropdownItem,
} from "@/lib/navigation/public-nav";
import { useAnnouncementBar } from "@/providers/AnnouncementBarProvider";

const defaultUserImage = "/avif/static/assets/default-profile.avif";

// ─── Dropdown Panel (Desktop) ────────────────────────────────────────────────

function DropdownLink({
  item,
  onClose,
}: {
  item: NavDropdownItem;
  onClose: () => void;
}) {
  const Icon = item.icon;
  const body = (
    <>
      <div className="mt-0.5 w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground flex items-center gap-2">
          {item.label}
          {item.disabled && (
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              Soon
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {item.description}
        </p>
      </div>
    </>
  );
  const rowClass = "flex items-start gap-3 px-3 py-2.5 rounded-lg";
  if (item.disabled) {
    return (
      <div
        aria-disabled="true"
        className={`${rowClass} opacity-60 cursor-not-allowed`}
      >
        {body}
      </div>
    );
  }
  return (
    <Link
      href={item.href}
      onClick={onClose}
      className={`${rowClass} transition-colors hover:bg-muted`}
    >
      {body}
    </Link>
  );
}

function DesktopDropdownPanel({
  group,
  onClose,
  panelId,
}: {
  group: NavDropdownGroup;
  onClose: () => void;
  panelId: string;
}) {
  const isMega = group.variant === "mega";
  const isWide = group.columns.length > 2;
  const panelWidth = isMega ? (isWide ? "w-[860px]" : "w-[620px]") : "w-80";
  const panelGrid = isWide ? "grid-cols-3" : "grid-cols-2";

  return (
    <div
      id={panelId}
      // Mega panels centre on the VIEWPORT (fixed), list panels on their
      // trigger (absolute) — an 860px panel hung off a narrow left-side trigger
      // reads as badly misaligned.
      //
      // Centred with `inset-x-0 mx-auto`, never `left-1/2 -translate-x-1/2`:
      // a transform-based centre fights other transforms. Margin centring
      // can't be clobbered.
      className={`inset-x-0 mx-auto bg-popover rounded-xl shadow-xl border border-border overflow-hidden z-[1100] animate-in fade-in slide-in-from-top-1 duration-150 ${
        isMega
          ? `fixed max-w-[calc(100vw-2rem)] ${panelWidth}`
          : `absolute top-full mt-2 ${panelWidth}`
      }`}
      style={
        isMega
          ? {
              top: `calc(var(--maintenance-banner-height, 0px) + var(--announcement-bar-height, 0px) + var(--navbar-height) + 0.5rem)`,
            }
          : undefined
      }
    >
      <div className={isMega ? `p-4 grid gap-2 ${panelGrid}` : "p-2"}>
        {group.columns.map((column) => (
          <div key={column.heading} className="min-w-0">
            {isMega && (
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground px-3 pb-1.5">
                {column.heading}
              </p>
            )}
            {column.items.map((item) => (
              <DropdownLink
                key={item.href + item.label}
                item={item}
                onClose={onClose}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Category chips */}
      {group.categoryChips && group.categoryChips.length > 0 && (
        <div className="border-t border-border px-4 py-3">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
            {group.categoryHeading ?? "By Category"}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {group.categoryChips.map((chip) => (
              <Link
                key={chip.href}
                href={chip.href}
                onClick={onClose}
                className="text-xs px-2.5 py-1 rounded-full bg-muted text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                {chip.label}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Desktop Nav Item ────────────────────────────────────────────────────────

function DesktopNavItem({
  group,
  showDarkStyle,
}: {
  group: NavDropdownGroup;
  showDarkStyle: boolean;
}) {
  const [open, setOpen] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = `nav-panel-${group.label.toLowerCase().replace(/\s+/g, "-")}`;

  const handleEnter = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setOpen(true);
  }, []);

  const handleLeave = useCallback(() => {
    timeoutRef.current = setTimeout(() => setOpen(false), 150);
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  // The panel previously closed on mouse-leave only: no Escape, no
  // outside-click, no focus return — so a keyboard user could open it and had
  // no way to dismiss it without tabbing through every link inside.
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    // Pointer-down outside and focus leaving the group are the same condition:
    // the interaction moved somewhere this menu doesn't own.
    const handleInteractionOutside = (event: Event) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handleInteractionOutside);
    document.addEventListener("focusin", handleInteractionOutside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handleInteractionOutside);
      document.removeEventListener("focusin", handleInteractionOutside);
    };
  }, [open]);

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <button
        ref={triggerRef}
        className={`inline-flex items-center gap-1 px-2 xl:px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
          showDarkStyle
            ? "text-white hover:bg-white/10"
            : "text-foreground hover:bg-muted"
        }`}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={open ? panelId : undefined}
      >
        {group.label}
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <DesktopDropdownPanel
          group={group}
          panelId={panelId}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Main Navbar ─────────────────────────────────────────────────────────────

const Navbar = () => {
  const pathname = usePathname();
  // The root layout is static (#932), so the session hydrates client-side here,
  // which makes the whole gap between FCP and this bar settling the /api/auth
  // round trip itself. `useRememberedAuth` fills that gap with the last resolved
  // shape (adopted before paint, never during render — hydration must match) and
  // the real session overwrites it the moment it lands.
  const { data: session, isPending } = useSession();
  const remembered = useRememberedAuth();
  const authView = resolveAuthView({
    isPending,
    user: session?.user,
    remembered,
  });
  const isAuthedView = authView.mode === "authed";
  const [isOpen, setIsOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const remoteFacets = useDashboardFacets(
    session?.user,
    accountMenuOpen || isOpen,
  );
  const [isScrolled, setIsScrolled] = useState(false);
  const { currency, symbol, setCurrency, isEstimate } = useCurrency();
  const { isVisible: isAnnouncementVisible } = useAnnouncementBar();

  // Route lists live in lib/navigation/public-chrome.ts — they were duplicated
  // across Navbar/Footer/HeaderSpacer and had already drifted.
  const darkHero = hasDarkHero(pathname);

  const toggleMenu = () => setIsOpen(!isOpen);
  const closeMenu = () => setIsOpen(false);

  useEffect(() => {
    const checkScroll = () => setIsScrolled(window.scrollY > 50);
    window.addEventListener("scroll", checkScroll);
    return () => window.removeEventListener("scroll", checkScroll);
  }, []);

  if (isChromeHidden(pathname)) return null;

  const handleSignOut = async () => {
    // signOutEverywhere keeps the #248 SDK-free disconnect path internally.
    await signOutEverywhere("/auth/signin");
    closeMenu();
  };

  const { links: facetLinks, loading: facetsLoading } = accountFacetLinks(
    session?.user ?? {},
    remoteFacets,
  );
  const baseLinks = accountBaseLinks(session?.user ?? {});

  const getUserImage = () => {
    return authView.image && authView.image !== ""
      ? authView.image
      : defaultUserImage;
  };

  const showDarkStyle = darkHero && !isScrolled;

  return (
    <>
      {/* Main Navbar */}
      <nav
        className={`fixed w-full z-[1000] transition-all duration-300 ${
          showDarkStyle
            ? "bg-transparent"
            : "bg-background/90 backdrop-blur-xl border-b border-border shadow-sm"
        }`}
        style={{
          top: `calc(var(--maintenance-banner-height, 0px) + ${isAnnouncementVisible ? "var(--announcement-bar-height, 0px)" : "0px"})`,
        }}
      >
        {/* Full-width gutters, so the logo and account stay on the page edges at
            any zoom. The widest gutter starts at xl, one step after the page
            content's: the desktop bar is already tight between lg and xl. */}
        <div className="w-full px-4 md:px-8 xl:px-12">
          <div
            className="flex justify-between items-center"
            style={{ height: "var(--navbar-height)" }}
          >
            {/* Logo */}
            <Link href="/" className="flex-shrink-0">
              <div className="flex h-10 md:h-12 w-32 md:w-40 items-center">
                <BrandWordmark
                  size="nav"
                  tone={showDarkStyle ? "inverse" : "default"}
                />
              </div>
            </Link>

            {/* Desktop Navigation */}
            <div className="hidden lg:flex items-center gap-0.5">
              {isAuthedView && (
                <Link href="/dashboard">
                  <Button
                    variant="ghost"
                    className={`font-medium lg:px-3 xl:px-4 ${showDarkStyle ? "text-white hover:bg-white/10" : "text-foreground hover:bg-muted"}`}
                  >
                    Dashboard
                  </Button>
                </Link>
              )}

              {NAV_GROUPS.map((group) => (
                <DesktopNavItem
                  key={group.label}
                  group={group}
                  showDarkStyle={showDarkStyle}
                />
              ))}

              {NAV_FLAT_LINKS.map((link) => (
                <Link key={link.href} href={link.href}>
                  <Button
                    variant="ghost"
                    className={`font-medium lg:px-3 xl:px-4 ${showDarkStyle ? "text-white hover:bg-white/10" : "text-foreground hover:bg-muted"}`}
                  >
                    {link.label}
                  </Button>
                </Link>
              ))}
            </div>

            {/* Desktop Auth / CTA Buttons */}
            <div className="hidden lg:flex items-center gap-3">
              {/* Currency Selector */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`gap-1 text-xs font-medium px-2 ${
                      showDarkStyle
                        ? "text-zinc-300 hover:text-white hover:bg-white/10"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    }`}
                  >
                    {symbol} {currency}
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[120px]">
                  {SUPPORTED_CURRENCIES.map((c) => (
                    <DropdownMenuItem
                      key={c.code}
                      onClick={() => setCurrency(c.code)}
                      className={
                        currency === c.code ? "bg-accent font-medium" : ""
                      }
                    >
                      {c.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* #1396 — ExchangeRate-API's Open Access licence requires this
                  attribution wherever its rates are shown, and the switcher is
                  where a visitor turns those rates on. Rendered only while the
                  prices really are converted: `isEstimate` is false for INR and
                  false during the no-rate degrade, when nothing on the page is
                  the provider's work. */}
              {isEstimate && (
                <a
                  href={RATE_PROVIDER_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`hidden lg:inline text-[10px] leading-none whitespace-nowrap underline underline-offset-2 ${
                    showDarkStyle
                      ? "text-zinc-400 hover:text-zinc-200"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Rates by {RATE_PROVIDER_NAME}
                </a>
              )}

              {authView.mode === "unknown" ? (
                <div className="flex items-center gap-3">
                  <Skeleton className="h-9 w-9 rounded-full" />
                  <Skeleton className="h-9 w-28 rounded-md" />
                </div>
              ) : isAuthedView ? (
                <DropdownMenu
                  open={accountMenuOpen}
                  onOpenChange={setAccountMenuOpen}
                >
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="Account menu"
                      className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Avatar className="h-9 w-9 border-2 border-zinc-200 hover:border-zinc-400 transition-colors cursor-pointer">
                        <AvatarImage src={getUserImage()} alt="Profile" />
                        <AvatarFallback className="bg-zinc-900 text-white text-sm">
                          {authView.name?.charAt(0) ?? "U"}
                        </AvatarFallback>
                      </Avatar>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    {authView.name && (
                      <>
                        <DropdownMenuLabel className="truncate">
                          {authView.name}
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                      </>
                    )}
                    {facetLinks.map((link) => (
                      <DropdownMenuItem key={link.key} asChild>
                        <Link href={link.href}>{link.label}</Link>
                      </DropdownMenuItem>
                    ))}
                    {facetsLoading && (
                      <output
                        aria-label="Loading dashboards"
                        className="block px-2 py-1.5"
                      >
                        <Skeleton className="h-4 w-32" />
                      </output>
                    )}
                    <DropdownMenuSeparator />
                    {baseLinks.map((link) => (
                      <DropdownMenuItem key={link.key} asChild>
                        <Link href={link.href}>{link.label}</Link>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={handleSignOut}>
                      Sign out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button
                  asChild
                  variant="ghost"
                  className={`font-medium ${showDarkStyle ? "text-white hover:bg-white/10" : "text-foreground hover:bg-muted"}`}
                >
                  <Link href="/auth/signin" onClick={closeMenu}>
                    Sign in
                  </Link>
                </Button>
              )}
            </div>

            {/* Mobile Menu Toggle */}
            <button
              onClick={toggleMenu}
              aria-label="Toggle Navigation"
              className={`lg:hidden p-2 rounded-lg transition-colors ${
                showDarkStyle
                  ? "text-white hover:bg-white/10"
                  : "text-foreground hover:bg-muted"
              }`}
            >
              {isOpen ? (
                <X className="w-6 h-6" />
              ) : (
                <Menu className="w-6 h-6" />
              )}
            </button>
          </div>
        </div>
      </nav>

      {/* Mobile Drawer — CSS transitions only; framer-motion was pulled into
          every public page via the root navbar for enter/exit polish.
          #1414 — both entrances are motion-safe: gated; with reduced motion
          requested they render in their final position, unanimated. */}
      {isOpen && (
        <>
          {/* Backdrop — native button so keyboard/AT get a real interactive
                control (Sonar typescript:S6848 / S1082). */}
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[1001] lg:hidden motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
            onClick={closeMenu}
          />

          {/* Drawer */}
          <div className="lg:hidden fixed top-0 left-0 h-full w-[85%] max-w-sm bg-zinc-950 z-[1002] shadow-2xl safe-top safe-bottom safe-left motion-safe:animate-in motion-safe:slide-in-from-left motion-safe:duration-300">
            {/* Drawer Header */}
            <div className="flex justify-between items-center p-5 border-b border-zinc-800">
              <div className="flex h-8 w-28 items-center">
                <BrandWordmark size="sm" tone="inverse" />
              </div>
              <button
                type="button"
                aria-label="Close menu"
                onClick={closeMenu}
                className="w-9 h-9 flex items-center justify-center rounded-full bg-zinc-800 hover:bg-zinc-700 transition-colors text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Navigation — Accordion Sections */}
            <div
              className="flex flex-col p-5 overflow-y-auto"
              style={{ maxHeight: "calc(100% - 10rem)" }}
            >
              {isAuthedView && (
                <Link
                  href="/dashboard"
                  className="flex items-center gap-3 px-4 py-3 rounded-xl text-white hover:bg-zinc-800 transition-colors mb-1"
                  onClick={closeMenu}
                >
                  <span className="font-medium">Dashboard</span>
                </Link>
              )}

              <Accordion type="multiple" className="w-full">
                {NAV_GROUPS.map((group) => (
                  <AccordionItem
                    key={group.label}
                    value={group.label}
                    className="border-b border-zinc-800"
                  >
                    <AccordionTrigger className="text-white hover:no-underline px-4 py-3">
                      {group.label}
                    </AccordionTrigger>
                    <AccordionContent className="px-2 pb-2">
                      <div className="space-y-1">
                        {group.columns.map((column) => (
                          <div key={column.heading}>
                            {/* Column headings only earn their space when
                                  there's more than one column to separate. */}
                            {group.columns.length > 1 && (
                              <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 px-4 pt-2 pb-1">
                                {column.heading}
                              </p>
                            )}
                            {column.items.map((item) => {
                              const label = (
                                <>
                                  <span className="text-sm font-medium text-white flex items-center gap-2">
                                    {item.label}
                                    {item.disabled && (
                                      <span className="text-[10px] uppercase tracking-wider text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">
                                        Soon
                                      </span>
                                    )}
                                  </span>
                                  <span className="text-xs text-zinc-500 mt-0.5 block">
                                    {item.description}
                                  </span>
                                </>
                              );
                              return item.disabled ? (
                                <div
                                  key={item.href + item.label}
                                  aria-disabled="true"
                                  className="block px-4 py-2.5 rounded-lg opacity-50"
                                >
                                  {label}
                                </div>
                              ) : (
                                <Link
                                  key={item.href + item.label}
                                  href={item.href}
                                  onClick={closeMenu}
                                  className="block px-4 py-2.5 rounded-lg transition-colors hover:bg-zinc-800"
                                >
                                  {label}
                                </Link>
                              );
                            })}
                          </div>
                        ))}

                        {/* Category chips on mobile */}
                        {group.categoryChips &&
                          group.categoryChips.length > 0 && (
                            <div className="px-4 pt-2">
                              <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 mb-2">
                                {group.categoryHeading ?? "By Category"}
                              </p>
                              <div className="flex flex-wrap gap-1.5">
                                {group.categoryChips.map((chip) => (
                                  <Link
                                    key={chip.href}
                                    href={chip.href}
                                    onClick={closeMenu}
                                    className="text-xs px-2.5 py-1 rounded-full bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white transition-colors"
                                  >
                                    {chip.label}
                                  </Link>
                                ))}
                              </div>
                            </div>
                          )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>

              {NAV_FLAT_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl text-white hover:bg-zinc-800 transition-colors mt-1"
                  onClick={closeMenu}
                >
                  <span className="font-medium">{link.label}</span>
                </Link>
              ))}

              {/* Mobile Currency Selector */}
              <div className="px-4 pt-4 mt-2 border-t border-zinc-800">
                <span className="text-xs text-zinc-500 uppercase tracking-wide">
                  Currency
                </span>
                <div className="flex flex-wrap gap-2 mt-2">
                  {SUPPORTED_CURRENCIES.map((c) => (
                    <button
                      key={c.code}
                      onClick={() => setCurrency(c.code)}
                      className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                        currency === c.code
                          ? "bg-white text-zinc-900 font-medium"
                          : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                      }`}
                    >
                      {c.symbol} {c.code}
                    </button>
                  ))}
                </div>
                {/* Same licence term as the desktop switcher above. */}
                {isEstimate && (
                  <a
                    href={RATE_PROVIDER_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block text-[10px] text-zinc-500 underline underline-offset-2 hover:text-zinc-300"
                  >
                    Rates by {RATE_PROVIDER_NAME}
                  </a>
                )}
              </div>
            </div>

            {/* User Section */}
            <div className="absolute bottom-0 left-0 right-0 p-5 border-t border-zinc-800 bg-zinc-900 safe-bottom">
              {authView.mode === "unknown" ? (
                <div className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <Skeleton className="h-4 w-32 rounded" />
                </div>
              ) : isAuthedView ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-10 w-10 border border-zinc-700">
                      <AvatarImage src={getUserImage()} alt="Profile" />
                      <AvatarFallback className="bg-zinc-800 text-white">
                        {authView.name?.charAt(0) ?? "U"}
                      </AvatarFallback>
                    </Avatar>
                    <span className="text-white font-medium text-sm truncate max-w-[140px]">
                      {authView.name}
                    </span>
                  </div>
                  <ul aria-label="Account" className="space-y-1">
                    {[...facetLinks, ...baseLinks].map((link) => (
                      <li key={link.key}>
                        <Link
                          href={link.href}
                          onClick={closeMenu}
                          className="block rounded-md px-2 py-2 text-sm text-zinc-200 hover:bg-white/10"
                        >
                          {link.label}
                        </Link>
                      </li>
                    ))}
                    {facetsLoading && (
                      <li className="px-2 py-2">
                        <output aria-label="Loading dashboards">
                          <Skeleton className="h-4 w-32" />
                        </output>
                      </li>
                    )}
                    <li>
                      <Button
                        variant="ghost"
                        onClick={handleSignOut}
                        className="h-auto w-full justify-start px-2 py-2 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10"
                      >
                        Sign out
                      </Button>
                    </li>
                  </ul>
                </div>
              ) : (
                /* Mirrors the desktop bar: no marketing CTAs, sign in only. */
                <Button
                  asChild
                  className="w-full bg-white text-zinc-900 hover:bg-zinc-200"
                >
                  <Link href="/auth/signin" onClick={closeMenu}>
                    Sign in
                  </Link>
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
};

export default Navbar;
