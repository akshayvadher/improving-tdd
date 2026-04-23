import { Body, Controller, Get, Param, Post } from '@nestjs/common';

import { CategoriesFacade, type NewCategoryDto } from './categories.facade.js';
import { type Category, type CategoryId } from './categories.types.js';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly facade: CategoriesFacade) {}

  @Post()
  createCategory(@Body() dto: NewCategoryDto): Promise<Category> {
    return this.facade.createCategory(dto);
  }

  @Get(':id')
  findCategoryById(@Param('id') id: CategoryId): Promise<Category> {
    return this.facade.findCategoryById(id);
  }
}
