# Landing categories bento, pastel version (v1)

The "Browse by expertise" section as it looked before the full-photo tiles replaced it: four pastel-tinted tiles on a five-column grid (Technology and Business & finance, then Creative Arts and Health & personal growth), each with a one-line benefit, white pill links to its fields' category pages with expert counts, and a photo inset or a small decorative product snippet.

| File                            | What it is                                         |
| ------------------------------- | -------------------------------------------------- |
| `pastel-v1-desktop.webp`        | The section at 1440px                              |
| `pastel-v1-phone.webp`          | The section at 390px                               |
| `category-page-v1-desktop.webp` | The Technology category page from the same release |
| `CategoriesSection.v1.tsx.txt`  | The component's source at that version             |
| `fields.v1.ts.txt`              | The field groups, details and photos it read       |

The source files end in `.txt` so the build, the linter and the type checker skip them. To bring this version back, copy them over `components/home/CategoriesSection.tsx` and `components/home/fields.ts`.
