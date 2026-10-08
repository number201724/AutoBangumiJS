import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { ConfigModule } from './config/config.module';
import { HealthController } from './health.controller';
import { ApiModule } from './api/api.module';
import { GlobalExceptionFilter } from './api/response';

@Module({
  imports: [ConfigModule, ApiModule],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
