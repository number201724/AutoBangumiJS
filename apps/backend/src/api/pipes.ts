/**
 * Strict int path-param pipe — mirrors FastAPI/pydantic int parsing (422 on
 * '5.5' / '5abc'), unlike NestJS ParseIntPipe which prefix-truncates.
 */
import { BadRequestException, HttpException, PipeTransform } from '@nestjs/common';

export class StrictIntPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
      throw new HttpException(
        {
          detail: [
            {
              loc: ['path', 'id'],
              msg: 'Input should be a valid integer',
              type: 'int_parsing',
            },
          ],
        },
        422,
      );
    }
    return Number(value);
  }
}

/** FastAPI bool 查询参数语义：true/1/yes/on/t/y（大小写不敏感）。 */
export function parseBoolQuery(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ['true', '1', 'yes', 'on', 't', 'y'].includes(value.toLowerCase());
}
