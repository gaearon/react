// A text-heavy section with many flat sibling paragraphs and no Suspense
// boundaries, modeled after https://github.com/mhart/react-server-defer-task
// (the reproduction for https://github.com/facebook/react/issues/35125).
//
// The first few paragraphs carry real prose; the rest are short "Paragraph N"
// fillers. Because everything here is a Server Component, all paragraphs
// flatten into the parent Flight row. Once that row crosses MAX_ROW_SIZE,
// every remaining sibling is deferred into its own tiny lazy row.

const LONG_PARAGRAPHS = [
  'The dashboard renders a considerable amount of static prose before any ' +
    'interactive content appears. This paragraph exists to give the section ' +
    'a realistic amount of leading text, similar to a documentation page or ' +
    'a long-form article, where the opening paragraphs carry most of the ' +
    'semantic weight and the rest of the page is made up of shorter, more ' +
    'repetitive fragments. Serialization strategies that work well for deep ' +
    'trees can behave very differently for wide, flat runs of siblings.',
  'When a framework serializes this page over the Flight protocol, the ' +
    'entire subtree is written into a single row until the accumulated row ' +
    'size crosses an internal threshold. After that point each remaining ' +
    'sibling is outlined into its own row and referenced lazily from the ' +
    'parent. For a page shaped like this one, that means a handful of large ' +
    'rows followed by thousands of rows that are only a few dozen bytes ' +
    'each, which stresses per-row bookkeeping on both server and client.',
  'The interesting question for the benchmark is where the time actually ' +
    'goes: into emitting and parsing the extra rows themselves, or into the ' +
    'machinery that models each deferred reference as a lazy value that ' +
    'throws when read before it resolves. The two explanations suggest very ' +
    'different fixes, so the fixture measures both sides separately rather ' +
    'than only reporting an end-to-end number for the whole pipeline.',
];

export default function ArticleSection({index, shortParagraphCount}) {
  const paragraphs = [];
  for (let i = 0; i < LONG_PARAGRAPHS.length; i++) {
    paragraphs.push(<p key={'long-' + i}>{LONG_PARAGRAPHS[i]}</p>);
  }
  for (let i = 0; i < shortParagraphCount; i++) {
    paragraphs.push(<p key={'short-' + i}>Paragraph {i + 1}</p>);
  }
  return (
    <section className="article-section">
      <h2>Section {index + 1}</h2>
      {paragraphs}
    </section>
  );
}
