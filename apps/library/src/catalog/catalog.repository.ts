import type { BookDto, BookId, CopyDto, CopyId, Isbn } from './catalog.types.js';

export interface CatalogRepository {
  saveBook(book: BookDto): Promise<void>;
  findBookById(bookId: BookId): Promise<BookDto | undefined>;
  findBookByIsbn(isbn: Isbn): Promise<BookDto | undefined>;
  listBooks(): Promise<BookDto[]>;

  saveCopy(copy: CopyDto): Promise<void>;
  findCopyById(copyId: CopyId): Promise<CopyDto | undefined>;
}
