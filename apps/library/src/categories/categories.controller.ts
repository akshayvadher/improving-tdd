import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { CategoriesFacade, type NewCategoryDto } from './categories.facade.js';
import {
  InvalidCategoriesQueryError,
  type Category,
  type CategoryId,
} from './categories.types.js';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly facade: CategoriesFacade) {}

  @Post()
  createCategory(@Body() dto: NewCategoryDto): Promise<Category> {
    return this.facade.createCategory(dto);
  }

  @Get()
  listByPrefix(@Query('startsWith') startsWith?: string): Promise<Category[]> {
    if (!startsWith || startsWith.trim() === '') {
      throw new InvalidCategoriesQueryError('startsWith is required');
    }
    return this.facade.listByPrefix(startsWith);
  }

  @Get(':id')
  findCategoryById(@Param('id') id: CategoryId): Promise<Category> {
    return this.facade.findCategoryById(id);
  }
}
