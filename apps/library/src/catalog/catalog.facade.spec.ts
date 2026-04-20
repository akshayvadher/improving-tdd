import { describe, expect, it } from 'vitest';

import { createCatalogFacade } from './catalog.configuration.js';
import {
  BookNotFoundError,
  CopyNotFoundError,
  CopyStatus,
  DuplicateIsbnError,
  InvalidBookError,
  InvalidCopyError,
} from './catalog.types.js';
import { sampleNewBook, sampleNewBookWithIsbn, sampleNewCopy } from './sample-catalog-data.js';

// Deterministic id generator so copy/book ids are predictable in assertions.
function sequentialIds(prefix = 'id'): () => string {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

function buildFacade() {
  return createCatalogFacade({ newId: sequentialIds() });
}

describe('CatalogFacade', () => {
  it('adds a book and finds it by isbn', async () => {
    // given a catalog
    const catalog = buildFacade();

    // when a book is added
    const added = await catalog.addBook(sampleNewBook({ isbn: '978-0134685991' }));

    // then it can be retrieved by its isbn
    expect(await catalog.findBook('978-0134685991')).toEqual(added);
  });

  it('lists all books in the order they were added', async () => {
    // given a catalog with two books
    const catalog = buildFacade();
    const first = await catalog.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const second = await catalog.addBook(sampleNewBookWithIsbn('978-0135957059'));

    // when listing all books
    const books = await catalog.listBooks();

    // then both books are returned in insertion order
    expect(books).toEqual([first, second]);
  });

  it('registers a copy of an existing book and finds the copy', async () => {
    // given a book in the catalog
    const catalog = buildFacade();
    const book = await catalog.addBook(sampleNewBook());

    // when a copy is registered for that book
    const copy = await catalog.registerCopy(book.bookId, sampleNewCopy({ bookId: book.bookId }));

    // then the copy is retrievable by its id
    expect(await catalog.findCopy(copy.copyId)).toEqual(copy);
  });

  it('registers new copies as available by default', async () => {
    // given a book in the catalog
    const catalog = buildFacade();
    const book = await catalog.addBook(sampleNewBook());

    // when a copy is registered
    const copy = await catalog.registerCopy(book.bookId, sampleNewCopy({ bookId: book.bookId }));

    // then its status is AVAILABLE
    expect(copy.status).toBe(CopyStatus.AVAILABLE);
  });

  it('marks an unavailable copy available again', async () => {
    // given a copy that has been marked unavailable
    const catalog = buildFacade();
    const book = await catalog.addBook(sampleNewBook());
    const copy = await catalog.registerCopy(book.bookId, sampleNewCopy({ bookId: book.bookId }));
    await catalog.markCopyUnavailable(copy.copyId);

    // when it is marked available
    const updated = await catalog.markCopyAvailable(copy.copyId);

    // then the copy reports as AVAILABLE
    expect(updated.status).toBe(CopyStatus.AVAILABLE);
    expect((await catalog.findCopy(copy.copyId)).status).toBe(CopyStatus.AVAILABLE);
  });

  it('marks an available copy unavailable', async () => {
    // given a newly registered (available) copy
    const catalog = buildFacade();
    const book = await catalog.addBook(sampleNewBook());
    const copy = await catalog.registerCopy(book.bookId, sampleNewCopy({ bookId: book.bookId }));

    // when it is marked unavailable
    const updated = await catalog.markCopyUnavailable(copy.copyId);

    // then the copy reports as UNAVAILABLE
    expect(updated.status).toBe(CopyStatus.UNAVAILABLE);
    expect((await catalog.findCopy(copy.copyId)).status).toBe(CopyStatus.UNAVAILABLE);
  });

  it('throws BookNotFoundError when finding an unknown isbn', async () => {
    // given an empty catalog
    const catalog = buildFacade();

    // when / then looking up an isbn that was never added
    await expect(catalog.findBook('978-0000000000')).rejects.toThrow(BookNotFoundError);
  });

  it('throws BookNotFoundError when registering a copy for an unknown book', async () => {
    // given an empty catalog
    const catalog = buildFacade();

    // when / then registering a copy against a non-existent bookId
    await expect(
      catalog.registerCopy('unknown-book-id', sampleNewCopy({ bookId: 'unknown-book-id' })),
    ).rejects.toThrow(BookNotFoundError);
  });

  it('throws CopyNotFoundError when marking an unknown copy available', async () => {
    // given an empty catalog
    const catalog = buildFacade();

    // when / then marking a copy id that was never registered
    await expect(catalog.markCopyAvailable('unknown-copy-id')).rejects.toThrow(CopyNotFoundError);
  });

  it('throws CopyNotFoundError when marking an unknown copy unavailable', async () => {
    // given an empty catalog
    const catalog = buildFacade();

    // when / then marking a copy id that was never registered
    await expect(catalog.markCopyUnavailable('unknown-copy-id')).rejects.toThrow(CopyNotFoundError);
  });

  it('rejects adding a book with a blank title', async () => {
    // given a catalog
    const catalog = buildFacade();

    // when / then adding a book whose title is empty or whitespace-only
    await expect(catalog.addBook(sampleNewBook({ title: '' }))).rejects.toThrow(InvalidBookError);
    await expect(catalog.addBook(sampleNewBook({ title: '   ' }))).rejects.toThrow(
      InvalidBookError,
    );
  });

  it('rejects adding a book with no authors', async () => {
    // given a catalog
    const catalog = buildFacade();

    // when / then adding a book whose authors array is empty or all-blank
    await expect(catalog.addBook(sampleNewBook({ authors: [] }))).rejects.toThrow(InvalidBookError);
    await expect(catalog.addBook(sampleNewBook({ authors: ['  '] }))).rejects.toThrow(
      InvalidBookError,
    );
  });

  it('rejects adding a book with a malformed isbn', async () => {
    // given a catalog
    const catalog = buildFacade();

    // when / then adding a book with an isbn that is empty, too short, or not digits
    await expect(catalog.addBook(sampleNewBook({ isbn: '' }))).rejects.toThrow(InvalidBookError);
    await expect(catalog.addBook(sampleNewBook({ isbn: '123' }))).rejects.toThrow(InvalidBookError);
    await expect(catalog.addBook(sampleNewBook({ isbn: 'not-an-isbn' }))).rejects.toThrow(
      InvalidBookError,
    );
  });

  it('accepts well-formed isbn-10 and isbn-13, with or without hyphens', async () => {
    // given a catalog
    const catalog = buildFacade();

    // when books are added with each accepted ISBN format
    const isbn13Hyphenated = await catalog.addBook(sampleNewBook({ isbn: '978-0134685991' }));
    const isbn13Plain = await catalog.addBook(sampleNewBook({ isbn: '9780135957059' }));
    const isbn10 = await catalog.addBook(sampleNewBook({ isbn: '0-306-40615-2' }));

    // then all three are stored and findable by their exact ISBN string
    expect(await catalog.findBook('978-0134685991')).toEqual(isbn13Hyphenated);
    expect(await catalog.findBook('9780135957059')).toEqual(isbn13Plain);
    expect(await catalog.findBook('0-306-40615-2')).toEqual(isbn10);
  });

  it('trims surrounding whitespace from title, authors, and isbn on addBook', async () => {
    // given a catalog
    const catalog = buildFacade();

    // when a book is added with padded title, authors, and isbn
    const book = await catalog.addBook(
      sampleNewBook({
        title: '  The Pragmatic Programmer  ',
        authors: ['  Andrew Hunt  ', '  David Thomas  '],
        isbn: '  978-0135957059  ',
      }),
    );

    // then the stored values are trimmed
    expect(book.title).toBe('The Pragmatic Programmer');
    expect(book.authors).toEqual(['Andrew Hunt', 'David Thomas']);
    expect(book.isbn).toBe('978-0135957059');
  });

  it('rejects registering a copy with an invalid condition', async () => {
    // given a book in the catalog
    const catalog = buildFacade();
    const book = await catalog.addBook(sampleNewBook());

    // when / then registering a copy with a condition outside the allowed set
    await expect(
      catalog.registerCopy(book.bookId, { bookId: book.bookId, condition: 'BROKEN' as never }),
    ).rejects.toThrow(InvalidCopyError);
  });

  it('rejects adding a book with an isbn that already exists', async () => {
    // given a catalog that already has a book with a particular isbn
    const catalog = buildFacade();
    await catalog.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when / then adding another book with the same isbn
    await expect(catalog.addBook(sampleNewBookWithIsbn('978-0134685991'))).rejects.toThrow(
      DuplicateIsbnError,
    );
  });
});
