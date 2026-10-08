/**
 * /api/v1/movie — 1:1 port of module/api/movie.py.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Res,
  UseGuards,
} from '@nestjs/common';
import { StrictIntPipe } from './pipes';
import type { Response } from 'express';

import { db } from '../database/facade';
import { AuthGuard } from '../security/api';
import type { NewMovieRow } from '../database/schema';

@Controller('/api/v1/movie')
@UseGuards(AuthGuard)
export class MovieController {
  @Get('/get/all')
  getAllMovies() {
    return db.movie.searchAll();
  }

  @Get('/get/:movie_id')
  getMovie(@Param('movie_id', StrictIntPipe) movieId: number, @Res() res: Response) {
    const movie = db.movie.searchId(movieId);
    if (!movie) {
      res.status(404).json({
        msg_en: `Movie ${movieId} not found.`,
        msg_zh: `未找到剧场版 ${movieId}。`,
      });
      return;
    }
    res.json(movie);
  }

  @Patch('/update/:movie_id')
  updateMovie(
    @Param('movie_id', StrictIntPipe) movieId: number,
    @Body() data: Partial<NewMovieRow>,
    @Res() res: Response,
  ) {
    const success = db.movie.update({ ...data, id: movieId });
    if (success) {
      res.json({ msg_en: 'Movie updated.', msg_zh: '剧场版已更新。' });
      return;
    }
    res.status(404).json({
      msg_en: `Movie ${movieId} not found.`,
      msg_zh: `未找到剧场版 ${movieId}。`,
    });
  }

  @Delete('/delete/:movie_id')
  deleteMovie(@Param('movie_id', StrictIntPipe) movieId: number) {
    db.movie.deleteOne(movieId);
    return { msg_en: 'Movie deleted.', msg_zh: '剧场版已删除。' };
  }

  @Delete('/disable/:movie_id')
  disableMovie(@Param('movie_id', StrictIntPipe) movieId: number) {
    db.movie.disableRule(movieId);
    return { msg_en: 'Movie disabled.', msg_zh: '剧场版已禁用。' };
  }

  @Get('/enable/:movie_id')
  enableMovie(@Param('movie_id', StrictIntPipe) movieId: number) {
    db.movie.enableRule(movieId);
    return { msg_en: 'Movie enabled.', msg_zh: '剧场版已启用。' };
  }
}
