import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TaskActivity, TaskActivitySchema } from './schemas/task-activity.schema';
import { TaskActivityService } from './task-activity.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: TaskActivity.name, schema: TaskActivitySchema }]),
  ],
  providers: [TaskActivityService],
  exports: [TaskActivityService, MongooseModule],
})
export class TaskActivityModule {}
