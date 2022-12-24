import {reactive} from 'vue';

export const store = reactive({
  target: 'last',
  previous: '',
  data: '',
  outDatad: '',
  setTarget(change:string, data?:string) {
    this.previous = this.target;
    this.target = change;
    if (data != null) {
      this.outDatad = this.data;
      this.data = data;
    }
  },
});
