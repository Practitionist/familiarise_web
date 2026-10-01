/** @jsxImportSource @/lib/pdf/react-runtime */
import {
  Document,
  Page,
  View,
  Text,
  Link,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
import { BODY_FONT } from "./statutory-document-frame";
import { groupCurriculumBySection } from "@/lib/labels/plan-labels";
import type { PlanBrochureData } from "./plan-brochure-data";

const styles = StyleSheet.create({
  page: {
    padding: 36,
    paddingBottom: 64,
    fontFamily: BODY_FONT,
    fontSize: 10,
    color: "#27272a",
  },
  hero: {
    backgroundColor: "#09090b",
    color: "#fafafa",
    padding: 24,
    marginBottom: 20,
    borderRadius: 12,
  },
  eyebrow: { fontSize: 8, letterSpacing: 1, marginBottom: 10, color: "#a1a1aa" },
  title: { fontSize: 22, fontWeight: 700, lineHeight: 1.2, marginBottom: 8 },
  subtitle: { color: "#d4d4d8", fontSize: 11, marginBottom: 6 },
  heroMetaRow: {
    marginTop: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  expert: { fontSize: 10, color: "#d4d4d8" },
  expertHeadline: { fontSize: 9, color: "#a1a1aa", marginTop: 2 },
  priceBadge: {
    fontSize: 14,
    fontWeight: 700,
    color: "#fafafa",
  },
  facts: { fontSize: 10, color: "#52525b", marginBottom: 20 },
  sectionBlock: { marginBottom: 16 },
  heading: { fontSize: 12, fontWeight: 700, marginBottom: 6, color: "#18181b" },
  bodyText: { fontSize: 10, lineHeight: 1.45, color: "#3f3f46" },
  bullet: { marginBottom: 4, color: "#3f3f46" },
  topicsText: { fontSize: 9.5, color: "#52525b" },
  faqBlock: { marginBottom: 8 },
  faqQuestion: {
    fontSize: 10,
    fontWeight: 700,
    color: "#27272a",
    marginBottom: 2,
  },
  faqAnswer: { fontSize: 9.5, color: "#52525b", lineHeight: 1.4 },
  curriculumTitle: { fontSize: 20, fontWeight: 700, marginBottom: 18 },
  group: {
    fontSize: 11,
    fontWeight: 700,
    color: "#52525b",
    marginTop: 12,
    marginBottom: 10,
  },
  divider: {
    marginTop: 12,
    marginBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#e4e4e7",
  },
  itemTitle: { fontSize: 11, fontWeight: 700 },
  itemDescription: { color: "#52525b" },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 36,
    right: 36,
    fontSize: 8,
    color: "#71717a",
    textAlign: "center",
  },
  note: { marginTop: 18, fontSize: 9, color: "#52525b" },
  link: { marginTop: 6, fontSize: 8, color: "#27272a" },
});

function Bullets({
  title,
  items,
}: Readonly<{ title: string; items: string[] }>) {
  if (!items.length) return null;
  return (
    <View style={styles.sectionBlock}>
      <Text style={styles.heading}>{title}</Text>
      {items.map((item, idx) => (
        <Text key={`${idx}-${item}`} style={styles.bullet}>
          • {item}
        </Text>
      ))}
    </View>
  );
}

function Footer() {
  return (
    <Text
      fixed
      style={styles.footer}
      render={({ pageNumber, totalPages }) =>
        `Familiarise · Plan brochure · ${pageNumber} / ${totalPages}`
      }
    />
  );
}

export async function renderPlanBrochure(
  data: PlanBrochureData,
): Promise<Buffer> {
  const generated = new Date(data.generatedAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const pdfBuffer = await renderToBuffer(
    <Document
      title={data.title}
      author="Familiarise"
      subject={data.curriculumHeading}
    >
      <Page size="A4" style={styles.page}>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>
            FAMILIARISE / {data.kind.toUpperCase()}
          </Text>
          <Text style={styles.title}>{data.title}</Text>
          {data.subtitle ? (
            <Text style={styles.subtitle}>{data.subtitle}</Text>
          ) : null}
          {data.expertName || data.priceFormatted ? (
            <View style={styles.heroMetaRow}>
              <View>
                {data.expertName ? (
                  <Text style={styles.expert}>With {data.expertName}</Text>
                ) : null}
                {data.expertHeadline ? (
                  <Text style={styles.expertHeadline}>
                    {data.expertHeadline}
                  </Text>
                ) : null}
              </View>
              {data.priceFormatted ? (
                <Text style={styles.priceBadge}>{data.priceFormatted}</Text>
              ) : null}
            </View>
          ) : null}
        </View>
        {data.facts.length > 0 ? (
          <Text style={styles.facts}>{data.facts.join(" · ")}</Text>
        ) : null}
        {data.description ? (
          <View style={styles.sectionBlock}>
            <Text style={styles.heading}>About this plan</Text>
            <Text style={styles.bodyText}>{data.description}</Text>
          </View>
        ) : null}
        <Bullets title="Who this is for" items={data.targetAudience} />
        <Bullets title="What you’ll learn" items={data.learningOutcomes} />
        <Bullets title="What’s included" items={data.whatsIncluded} />
        {data.prerequisites ? (
          <View style={styles.sectionBlock}>
            <Text style={styles.heading}>Prerequisites</Text>
            <Text style={styles.bodyText}>{data.prerequisites}</Text>
          </View>
        ) : null}
        {data.materialProvided ? (
          <View style={styles.sectionBlock}>
            <Text style={styles.heading}>Materials provided</Text>
            <Text style={styles.bodyText}>{data.materialProvided}</Text>
          </View>
        ) : null}
        {data.topics.length > 0 ? (
          <View style={styles.sectionBlock}>
            <Text style={styles.heading}>Topics covered</Text>
            <Text style={styles.topicsText}>{data.topics.join(" · ")}</Text>
          </View>
        ) : null}
        {data.faqs.length > 0 ? (
          <View style={styles.sectionBlock}>
            <Text style={styles.heading}>Frequently asked questions</Text>
            {data.faqs.map((faq, idx) => (
              <View key={`${idx}-${faq.question}`} style={styles.faqBlock}>
                <Text style={styles.faqQuestion}>Q: {faq.question}</Text>
                <Text style={styles.faqAnswer}>{faq.answer}</Text>
              </View>
            ))}
          </View>
        ) : null}
        <Text style={styles.note}>
          Your plan brochure, prepared on {generated}. Explore this offering
          online for the latest pricing, available dates, and booking options.
        </Text>
        <Link style={styles.link} src={data.planUrl}>
          View plan &amp; booking details
        </Link>
        <Footer />
      </Page>
      {data.curriculum.length > 0 ? (
        <Page size="A4" style={styles.page}>
          <Text style={styles.curriculumTitle}>{data.curriculumHeading}</Text>
          {groupCurriculumBySection(data.curriculum).map(
            (group, groupIndex) => (
              <View key={group.label ?? `group-${groupIndex}`}>
                {group.label ? (
                  <Text style={styles.group}>{group.label}</Text>
                ) : null}
                {group.items.map((item) => (
                  <View key={`${item.order}-${item.title}`}>
                    <Text>
                      <Text style={styles.itemTitle}>
                        {item.order}. {item.title}
                        {item.hoursAllotted ? ` · ${item.hoursAllotted}h` : ""}
                        {"\n"}
                      </Text>
                      <Text style={styles.itemDescription}>
                        {item.description}
                      </Text>
                      {item.outcomes?.map((outcome, outcomeIdx) => (
                        <Text key={`${outcomeIdx}-${outcome}`}>
                          {"\n"}• {outcome}
                        </Text>
                      ))}
                    </Text>
                    <View style={styles.divider} />
                  </View>
                ))}
              </View>
            ),
          )}
          <Footer />
        </Page>
      ) : null}
    </Document>,
  );
  return Buffer.from(pdfBuffer);
}
