import ArticleSection from './components/ArticleSection';

// Row-fragmentation reproduction for
// https://github.com/facebook/react/issues/35125.
//
// A ~120KB article-like page: `itemCount` sections, each with a few long
// prose paragraphs followed by 100 short sibling paragraphs. No Suspense
// boundaries, no client components, nothing async — the entire tree would
// fit in one Flight row if it weren't for the MAX_ROW_SIZE deferral.
//
// Because Server Components flatten into their parent's row, the root row
// accumulates until it crosses MAX_ROW_SIZE (3200) partway through the
// first section. From then on, every remaining sibling in the whole tree is
// deferred via deferTask into its own $L lazy row, producing thousands of
// rows that average ~60 bytes each.

const SHORT_PARAGRAPHS_PER_SECTION = 100;

export default function AppFragmented({itemCount}) {
  const sections = [];
  for (let i = 0; i < itemCount; i++) {
    sections.push(
      <ArticleSection
        key={i}
        index={i}
        shortParagraphCount={SHORT_PARAGRAPHS_PER_SECTION}
      />
    );
  }
  return (
    <html>
      <body>
        <main className="article">
          <h1>Row fragmentation reproduction</h1>
          {sections}
        </main>
      </body>
    </html>
  );
}
