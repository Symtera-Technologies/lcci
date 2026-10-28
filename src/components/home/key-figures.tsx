import { getKeyFigures } from "@/content/repository";
import { formatDate } from "@/lib/format";

/**
 * Figures render server-side as plain text.
 *
 * KCCI's homepage counters animate from zero in JavaScript and currently sit at
 * "0" for every stat — the failure mode of a count-up widget is showing nothing
 * at all. These are in the HTML whether or not script runs.
 */
export async function KeyFigures() {
  const figures = await getKeyFigures();
  const verified = figures[0]?.verifiedAt;

  return (
    <section className="border-y border-stone-200 bg-white">
      <div className="container-page py-14">
        <h2 className="sr-only">The chamber in numbers</h2>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-10 lg:grid-cols-4">
          {figures.map((f) => (
            <div key={f.id} className="border-s-2 border-brand-400 ps-5">
              <dt className="text-sm font-medium text-stone-500">{f.labelEn}</dt>
              <dd className="mt-1.5 font-display text-display-md font-semibold tabular-nums text-ink-950">
                {f.value.toLocaleString("en-GB")}
                {f.suffix && <span className="text-brand-600">{f.suffix}</span>}
              </dd>
            </div>
          ))}
        </dl>

        {verified && (
          <p className="mt-10 text-xs text-stone-400">
            Figures verified {formatDate(verified)} by the Research Department.
          </p>
        )}
      </div>
    </section>
  );
}
