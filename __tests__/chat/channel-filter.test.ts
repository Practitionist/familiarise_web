/**
 * The sidebar filter matches only what a row shows, so a filtered list never
 * holds a row that looks unrelated to the search.
 */
import type { Channel } from "stream-chat";

import {
  filterChannelsByTerm,
  MIN_SEARCH_LENGTH,
} from "../../components/chat/utils/channelUtils";

const user = (id: string, name: string) => ({ user: { id, name } });

function team(id: string, name: string): Channel {
  return {
    type: "team",
    id,
    data: { name },
    state: { members: {} },
  } as unknown as Channel;
}

function dm(id: string, ...people: Array<[string, string]>): Channel {
  return {
    type: "messaging",
    id,
    data: {},
    state: {
      members: Object.fromEntries(
        people.map(([uid, name]) => [uid, user(uid, name)]),
      ),
    },
  } as unknown as Channel;
}

const beginner = team("class-1", "Beginner Class");
const workshop = team("webinar-1", "Expert Workshop Webinar");
const liam = dm(
  "dm-me-liam",
  ["me", "Benjamin Brown"],
  ["liam", "Liam Anderson"],
);
const karen = dm(
  "dm-me-karen",
  ["me", "Benjamin Brown"],
  ["karen", "Karen Anderson"],
);
const group = dm(
  "dm-group",
  ["me", "Benjamin Brown"],
  ["a", "Asha Rao"],
  ["b", "Bilal Khan"],
);
const all = [beginner, workshop, liam, karen, group];

describe("filterChannelsByTerm", () => {
  it("returns the same list while the term is too short to filter by", () => {
    expect(filterChannelsByTerm(all, "me", "")).toBe(all);
    expect(filterChannelsByTerm(all, "me", " a ")).toBe(all);
    expect(MIN_SEARCH_LENGTH).toBe(2);
  });

  it("matches the other person's name, case-insensitively", () => {
    expect(filterChannelsByTerm(all, "me", "KAR")).toEqual([karen]);
    expect(filterChannelsByTerm(all, "me", "anderson")).toEqual([liam, karen]);
  });

  it("matches a team channel by its name", () => {
    expect(filterChannelsByTerm(all, "me", "workshop")).toEqual([workshop]);
  });

  it("matches any member of a group conversation", () => {
    expect(filterChannelsByTerm(all, "me", "bilal")).toEqual([group]);
  });

  it("never matches the viewer's own name", () => {
    expect(filterChannelsByTerm([liam, karen], "me", "benjamin")).toEqual([]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterChannelsByTerm(all, "me", "aar")).toEqual([]);
  });
});
