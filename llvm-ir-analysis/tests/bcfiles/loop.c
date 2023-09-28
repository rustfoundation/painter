int while_loop(int end) {
  volatile int a = 0, i = 0;
  do {
    a++;
  } while (++i < end);
  return a - 3;
}

int for_loop(int end) {
  volatile int a = 0;
  for(int i = 0; i < end; i++) {
    a++;
  }
  return a - 3;
}

int loop_zero_iterations(int end) {
  volatile int a = 3;
  if(end < 0) return 1;  // this way the function cannot return 0 when end < 0
  for(int i = 0; i < end; i++) {
    a++;
  }
  return a - 3;
}

int loop_with_cond(int end) {
  volatile int a = 0, i = 0;
  do {
    if(i % 3 == 0 || i > 6) a++;
  } while (++i < end);
  return a - 3;
}

int loop_inside_cond(int b) {
  volatile int a = 0;
  if (b > 7) {
    for (int i = 0; i < 3; i++) {
      a++;
    }
  } else {
    a = 2;
  }
  return a - 3;
}

int loop_over_array(int a) {
  volatile int arr[10];
  for(int i = 0; i < 10; i++) {
    arr[i] = a - i;
  }
  return arr[3];
}

int sum_of_array(int a) {
  volatile int arr[10];
  for(int i = 0; i < 10; i++) {
    arr[i] = a;
  }
  int sum = 0;
  for(int i = 0; i < 10; i++) {
    sum += arr[i];
  }
  return sum - 30;
}

int search_array(int a) {
  volatile int arr[10];
  for(int i = 0; i < 10; i++) {
    arr[i] = i * 3;
  }
  int found = 0;
  for(int i = 0; i < 10; i++) {
    if (arr[i] > 9) {
      found = i;
      break;
    }
  }
  return a - found;
}

int nested_loop(int end) {
  volatile int a = 0;
  for(int i = 0; i < end; i++) {
    for (int j = 0; j < 10; j++) {
      a++;
    }
  }
  return a - 30;
}

int infinite_loop() {
  while(1) {};
  return 1;
}
