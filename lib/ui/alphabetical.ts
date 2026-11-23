// Every list a person picks from (people, departments, teams, cost centres,
// users) is shown in alphabetical order of the label they read. Case and
// accents never split the list. Lists with a natural order (months, tiers,
// severities, products, models by price) and rankings do not use this.

/** Case- and accent-insensitive comparison of two visible labels. */
export function compareLabels(a: string, b: string): number {
  return a.localeCompare(b, 'en-GB', { sensitivity: 'base' });
}

/** A sorted copy of `items`, ordered by the label `label` returns. */
export function sortByLabel<T>(items: readonly T[], label: (item: T) => string): T[] {
  return [...items].sort((a, b) => compareLabels(label(a), label(b)));
}

/** A sorted copy of a list of plain strings (department names, team names). */
export function sortLabels(items: readonly string[]): string[] {
  return sortByLabel(items, s => s);
}
