; ModuleID = 'loop.c'
source_filename = "loop.c"
target datalayout = "e-m:o-p270:32:32-p271:32:32-p272:64:64-i64:64-f80:128-n8:16:32:64-S128"
target triple = "x86_64-apple-macosx11.0.0"

; Function Attrs: nofree nounwind ssp uwtable
define dso_local void @loop(i32 %0, i32 %1) local_unnamed_addr #0 {
  %3 = alloca [10 x i32], align 16
  %4 = bitcast [10 x i32]* %3 to i8*
  call void @llvm.lifetime.start.p0i8(i64 40, i8* nonnull %4) #3
  call void @llvm.memset.p0i8.i64(i8* nonnull align 16 %4, i8 0, i64 40, i1 true)
  %5 = add i32 %1, -1
  %6 = icmp ult i32 %5, 10
  br i1 %6, label %7, label %47

7:                                                ; preds = %2
  %8 = add nsw i32 %0, 3
  %9 = icmp sgt i32 %1, 1
  %10 = select i1 %9, i32 %1, i32 1
  %11 = getelementptr inbounds [10 x i32], [10 x i32]* %3, i64 0, i64 0
  store volatile i32 %8, i32* %11, align 16, !tbaa !3
  br i1 %9, label %12, label %47

12:                                               ; preds = %7
  %13 = zext i32 %10 to i64
  %14 = add nsw i64 %13, -1
  %15 = and i64 %14, 1
  %16 = icmp eq i32 %10, 2
  br i1 %16, label %37, label %17

17:                                               ; preds = %12
  %18 = and i64 %14, -2
  br label %19

19:                                               ; preds = %19, %17
  %20 = phi i64 [ 1, %17 ], [ %34, %19 ]
  %21 = phi i64 [ %18, %17 ], [ %35, %19 ]
  %22 = getelementptr inbounds [10 x i32], [10 x i32]* %3, i64 0, i64 %20
  store volatile i32 %8, i32* %22, align 4, !tbaa !3
  %23 = add nuw i64 %20, 4294967295
  %24 = and i64 %23, 4294967295
  %25 = getelementptr inbounds [10 x i32], [10 x i32]* %3, i64 0, i64 %24
  %26 = load volatile i32, i32* %25, align 4, !tbaa !3
  %27 = add nsw i32 %26, %1
  store volatile i32 %27, i32* %25, align 4, !tbaa !3
  %28 = add nuw nsw i64 %20, 1
  %29 = getelementptr inbounds [10 x i32], [10 x i32]* %3, i64 0, i64 %28
  store volatile i32 %8, i32* %29, align 4, !tbaa !3
  %30 = and i64 %20, 4294967295
  %31 = getelementptr inbounds [10 x i32], [10 x i32]* %3, i64 0, i64 %30
  %32 = load volatile i32, i32* %31, align 4, !tbaa !3
  %33 = add nsw i32 %32, %1
  store volatile i32 %33, i32* %31, align 4, !tbaa !3
  %34 = add nuw nsw i64 %20, 2
  %35 = add i64 %21, -2
  %36 = icmp eq i64 %35, 0
  br i1 %36, label %37, label %19, !llvm.loop !7

37:                                               ; preds = %19, %12
  %38 = phi i64 [ 1, %12 ], [ %34, %19 ]
  %39 = icmp eq i64 %15, 0
  br i1 %39, label %47, label %40

40:                                               ; preds = %37
  %41 = getelementptr inbounds [10 x i32], [10 x i32]* %3, i64 0, i64 %38
  store volatile i32 %8, i32* %41, align 4, !tbaa !3
  %42 = add nuw i64 %38, 4294967295
  %43 = and i64 %42, 4294967295
  %44 = getelementptr inbounds [10 x i32], [10 x i32]* %3, i64 0, i64 %43
  %45 = load volatile i32, i32* %44, align 4, !tbaa !3
  %46 = add nsw i32 %45, %1
  store volatile i32 %46, i32* %44, align 4, !tbaa !3
  br label %47

47:                                               ; preds = %40, %37, %7, %2
  call void @llvm.lifetime.end.p0i8(i64 40, i8* nonnull %4) #3
  ret void
}

; Function Attrs: argmemonly nofree nosync nounwind willreturn
declare void @llvm.lifetime.start.p0i8(i64 immarg, i8* nocapture) #1

; Function Attrs: argmemonly nofree nosync nounwind willreturn writeonly
declare void @llvm.memset.p0i8.i64(i8* nocapture writeonly, i8, i64, i1 immarg) #2

; Function Attrs: argmemonly nofree nosync nounwind willreturn
declare void @llvm.lifetime.end.p0i8(i64 immarg, i8* nocapture) #1

attributes #0 = { nofree nounwind ssp uwtable "disable-tail-calls"="false" "frame-pointer"="all" "less-precise-fpmad"="false" "min-legal-vector-width"="0" "no-infs-fp-math"="false" "no-jump-tables"="false" "no-nans-fp-math"="false" "no-signed-zeros-fp-math"="false" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="penryn" "target-features"="+cx16,+cx8,+fxsr,+mmx,+sahf,+sse,+sse2,+sse3,+sse4.1,+ssse3,+x87" "tune-cpu"="generic" "unsafe-fp-math"="false" "use-soft-float"="false" }
attributes #1 = { argmemonly nofree nosync nounwind willreturn }
attributes #2 = { argmemonly nofree nosync nounwind willreturn writeonly }
attributes #3 = { nounwind }

!llvm.module.flags = !{!0, !1}
!llvm.ident = !{!2}

!0 = !{i32 1, !"wchar_size", i32 4}
!1 = !{i32 7, !"PIC Level", i32 2}
!2 = !{!"Homebrew clang version 12.0.1"}
!3 = !{!4, !4, i64 0}
!4 = !{!"int", !5, i64 0}
!5 = !{!"omnipotent char", !6, i64 0}
!6 = !{!"Simple C/C++ TBAA"}
!7 = distinct !{!7, !8, !9}
!8 = !{!"llvm.loop.mustprogress"}
!9 = !{!"llvm.loop.peeled.count", i32 1}
