/** Text with every hit of the search wrapped in a `<mark>`. */
import { splitMatches } from "./search.js";

export function Marked({ text, query }: { text: string; query: string }) {
  if (query === "") return <>{text}</>;
  return (
    <>
      {splitMatches(text, query).map((part, index) =>
        part.match ? (
          <mark key={index} className="search__hit">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
