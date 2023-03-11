/** DOMTransformer: Abstract base class for classes that take document and apply some transformeation (e.g. reader view)
 *
 *
 */
export abstract class DOMTransformer {
    /**
     *
     * @param dom Document to update. This value is invalid after being passed to this function. Use the return value instead.
     * @returns The update document, with the transformation applied.
     */
    abstract apply(dom: Document): Document;
}
