import type { CatalogRepository } from './catalog.repository.js';
import type { BookDto, BookId, CopyDto, CopyId, Isbn } from './catalog.types.js';

export class InMemoryCatalogRepository implements CatalogRepository {
  private readonly booksById = new Map<BookId, BookDto>();
  private readonly copiesById = new Map<CopyId, CopyDto>();

  async saveBook(book: BookDto): Promise<void> {
    this.booksById.set(book.bookId, book);
  }

  async findBookById(bookId: BookId): Promise<BookDto | undefined> {
    return this.booksById.get(bookId);
  }

  async findBookByIsbn(isbn: Isbn): Promise<BookDto | undefined> {
    for (const book of this.booksById.values()) {
      if (book.isbn === isbn) {
        return book;
      }
    }
    return undefined;
  }

  async listBooks(): Promise<BookDto[]> {
    return Array.from(this.booksById.values());
  }

  async saveCopy(copy: CopyDto): Promise<void> {
    this.copiesById.set(copy.copyId, copy);
  }

  async findCopyById(copyId: CopyId): Promise<CopyDto | undefined> {
    return this.copiesById.get(copyId);
  }
}
