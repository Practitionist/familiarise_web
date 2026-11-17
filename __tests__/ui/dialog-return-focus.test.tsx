/**
 * A dialog opened from a button with no Radix Trigger (open-state controlled)
 * hands focus back to that button when it closes; a Trigger keeps Radix's own
 * return.
 */
import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

function ControlledAlert() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Cancel session
      </button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogTitle>Cancel this session?</AlertDialogTitle>
          <AlertDialogDescription>It cannot be undone.</AlertDialogDescription>
          <AlertDialogCancel>Keep booking</AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ControlledDialog() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Re-time
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Move to a new date</DialogTitle>
          <DialogDescription>Pick a new time.</DialogDescription>
        </DialogContent>
      </Dialog>
    </>
  );
}

function openFrom(name: string) {
  const opener = screen.getByRole("button", { name });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe("dialogs return focus to their opener", () => {
  it("a controlled AlertDialog closed with Escape focuses the button that opened it", async () => {
    render(<ControlledAlert />);
    const opener = openFrom("Cancel session");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Keep booking" }),
      ).toHaveFocus(),
    );
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("a controlled Dialog closed with Escape focuses the button that opened it", async () => {
    render(<ControlledDialog />);
    const opener = openFrom("Re-time");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("a caller that prevents the close focus keeps control of it", async () => {
    function Prevented() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <input aria-label="Elsewhere" />
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                screen.getByLabelText("Elsewhere").focus();
              }}
            >
              <DialogTitle>Prevented</DialogTitle>
              <DialogDescription>Body</DialogDescription>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    render(<Prevented />);
    openFrom("Open");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(screen.getByLabelText("Elsewhere")).toHaveFocus(),
    );
  });

  it("a Dialog with a Trigger still returns focus to the Trigger", async () => {
    render(
      <Dialog>
        <DialogTrigger>Open with trigger</DialogTrigger>
        <DialogContent>
          <DialogTitle>Triggered</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const trigger = openFrom("Open with trigger");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("an AlertDialog with a Trigger still returns focus to the Trigger", async () => {
    render(
      <AlertDialog>
        <AlertDialogTrigger>Delete</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Delete it?</AlertDialogTitle>
          <AlertDialogDescription>Body</AlertDialogDescription>
          <AlertDialogCancel>Keep</AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>,
    );
    const trigger = openFrom("Delete");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
