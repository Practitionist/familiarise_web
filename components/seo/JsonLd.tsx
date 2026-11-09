/** Escapes `<` so a `</script>` inside any field cannot close the block and inject markup. */
export function JsonLd({ data }: Readonly<{ data: unknown }>) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, String.raw`\u003c`),
      }}
    />
  );
}
