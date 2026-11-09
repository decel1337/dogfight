// Типобезпечний доступ до DOM без приведень типів: querySelector повертає
// `Element | null`, а потрібний підтип ми доводимо перевіркою instanceof.
type ElementClass<T extends Element> = abstract new (...args: never[]) => T;

export function query<T extends Element>(
  root: ParentNode,
  selector: string,
  type: ElementClass<T>,
): T {
  const element = root.querySelector(selector);
  if (!(element instanceof type)) {
    throw new Error(`Елемент ${selector} не знайдено або він має інший тип`);
  }
  return element;
}

export function queryAll<T extends Element>(
  root: ParentNode,
  selector: string,
  type: ElementClass<T>,
): T[] {
  return [...root.querySelectorAll(selector)].map((element) => {
    if (!(element instanceof type))
      throw new Error(`Елемент ${selector} має інший тип`);
    return element;
  });
}
