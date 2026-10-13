"use client";

import { useCallback, useMemo, useRef } from "react";

import { useToast } from "@/hooks/use-toast";
import {
  downloadAppointmentDocument,
  downloadPlanMaterial,
} from "./client-download";
import type { FileErrorViewer, FriendlyFileError } from "./file-errors";

/** Download actions that toast fixed error copy and ignore repeat clicks while one is in flight. */
export function useFileDownload() {
  const { toast } = useToast();
  const inFlight = useRef(new Set<string>());

  const run = useCallback(
    async (key: string, action: () => Promise<FriendlyFileError | null>) => {
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      try {
        const error = await action();
        if (error) {
          toast({
            title: error.title,
            description: error.description,
            variant: "destructive",
          });
        }
      } finally {
        inFlight.current.delete(key);
      }
    },
    [toast],
  );

  return useMemo(
    () => ({
      downloadDocument: (
        appointmentId: string,
        documentId: string,
        viewer?: FileErrorViewer,
      ) =>
        run(`doc:${documentId}`, () =>
          downloadAppointmentDocument(appointmentId, documentId, viewer),
        ),
      downloadMaterial: (materialId: string) =>
        run(`mat:${materialId}`, () => downloadPlanMaterial(materialId)),
    }),
    [run],
  );
}
