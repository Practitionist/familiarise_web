"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function useScrollSpy(sectionIds: readonly string[]) {
  const [activeSectionId, setActiveSectionId] = useState<string>(
    () => sectionIds[0] ?? "",
  );
  const tocNavRef = useRef<HTMLElement | null>(null);
  const clickLockUntilRef = useRef<number>(0);

  const selectSection = useCallback((id: string) => {
    clickLockUntilRef.current = Date.now() + 700;
    setActiveSectionId(id);
  }, []);

  useEffect(() => {
    if (sectionIds.length === 0) return;

    const elements = sectionIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);

    if (elements.length === 0) return;

    const computeActiveFromScroll = () => {
      if (Date.now() < clickLockUntilRef.current) return;

      const scrollOffset = 160;
      let currentId = sectionIds[0];

      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.top <= scrollOffset) {
          currentId = el.id;
        } else {
          break;
        }
      }

      if (
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 32
      ) {
        currentId = elements[elements.length - 1]?.id ?? currentId;
      }

      setActiveSectionId((prev) => (prev === currentId ? prev : currentId));
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (Date.now() < clickLockUntilRef.current) return;
        const intersecting = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
          );
        if (intersecting.length > 0) {
          const targetId = intersecting[0].target.id;
          if (targetId) {
            setActiveSectionId((prev) =>
              prev === targetId ? prev : targetId,
            );
            return;
          }
        }
        computeActiveFromScroll();
      },
      {
        rootMargin: "-120px 0px -65% 0px",
        threshold: [0, 0.1, 0.5, 1],
      },
    );

    for (const el of elements) {
      observer.observe(el);
    }

    const handleHashChange = () => {
      const hashId = window.location.hash.replace(/^#/, "");
      if (hashId && sectionIds.includes(hashId)) {
        clickLockUntilRef.current = Date.now() + 700;
        setActiveSectionId(hashId);
      }
    };

    if (window.location.hash) {
      handleHashChange();
    } else {
      computeActiveFromScroll();
    }

    window.addEventListener("scroll", computeActiveFromScroll, {
      passive: true,
    });
    window.addEventListener("hashchange", handleHashChange);

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", computeActiveFromScroll);
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, [sectionIds]);

  useEffect(() => {
    const nav = tocNavRef.current;
    if (!nav || !activeSectionId) return;
    const activeLink = nav.querySelector<HTMLElement>(
      `[data-toc-id="${activeSectionId}"]`,
    );
    if (!activeLink) return;

    const navRect = nav.getBoundingClientRect();
    const linkRect = activeLink.getBoundingClientRect();
    if (linkRect.top < navRect.top + 8 || linkRect.bottom > navRect.bottom - 8) {
      const targetScrollTop =
        linkRect.top -
        navRect.top +
        nav.scrollTop -
        nav.clientHeight / 2 +
        linkRect.height / 2;
      nav.scrollTo({
        top: Math.max(0, targetScrollTop),
        behavior: "smooth",
      });
    }
  }, [activeSectionId]);

  return { activeSectionId, tocNavRef, selectSection };
}
