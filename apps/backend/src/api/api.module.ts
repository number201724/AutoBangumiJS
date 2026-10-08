import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { BangumiController } from './bangumi.controller';
import { ConfigController } from './config.controller';
import { DownloaderController } from './downloader.controller';
import { EventsController } from './events.controller';
import { LlmController } from './llm.controller';
import { LogController } from './log.controller';
import { MovieController } from './movie.controller';
import { NotificationController } from './notification.controller';
import { PasskeyController } from './passkey.controller';
import { ProgramController } from './program.controller';
import { RssController } from './rss.controller';
import { SearchController } from './search.controller';
import { SetupController } from './setup.controller';
import { TokensController } from './tokens.controller';
import { UpdateController } from './update.controller';
import { UsersController } from './users.controller';

/** API v1 controllers (mirrors module/api/__init__.py include_router list). */
@Module({
  controllers: [
    AuthController,
    UsersController,
    TokensController,
    PasskeyController,
    LogController,
    ProgramController,
    BangumiController,
    MovieController,
    ConfigController,
    DownloaderController,
    EventsController,
    RssController,
    SearchController,
    SetupController,
    NotificationController,
    UpdateController,
    LlmController,
  ],
})
export class ApiModule {}
