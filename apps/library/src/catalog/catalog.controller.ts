import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';

import { CatalogFacade } from './catalog.facade.js';
import type {
  BookDto,
  BookId,
  CopyDto,
  CopyId,
  Isbn,
  NewBookDto,
  NewCopyDto,
} from './catalog.types.js';

@Controller()
export class CatalogController {
  constructor(private readonly facade: CatalogFacade) {}

  @Post('books')
  addBook(@Body() dto: NewBookDto): Promise<BookDto> {
    return this.facade.addBook(dto);
  }

  @Get('books')
  listBooks(): Promise<BookDto[]> {
    return this.facade.listBooks();
  }

  @Get('books/:isbn')
  findBook(@Param('isbn') isbn: Isbn): Promise<BookDto> {
    return this.facade.findBook(isbn);
  }

  @Post('books/:bookId/copies')
  registerCopy(@Param('bookId') bookId: BookId, @Body() dto: NewCopyDto): Promise<CopyDto> {
    return this.facade.registerCopy(bookId, dto);
  }

  @Patch('copies/:copyId/available')
  markCopyAvailable(@Param('copyId') copyId: CopyId): Promise<CopyDto> {
    return this.facade.markCopyAvailable(copyId);
  }

  @Patch('copies/:copyId/unavailable')
  markCopyUnavailable(@Param('copyId') copyId: CopyId): Promise<CopyDto> {
    return this.facade.markCopyUnavailable(copyId);
  }
}
